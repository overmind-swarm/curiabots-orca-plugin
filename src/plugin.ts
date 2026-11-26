// The connector itself: links, their sockets, pairing, and what the panel and status bar show.
// worker.ts is the thin Orca-facing shell around this class.
import { OrcaCli } from './cli.ts'
import type { ExecFn } from './cli.ts'
import { resolveEndpoints } from './endpoints.ts'
import { M } from './methods.ts'
import type { HostPort } from './host.ts'
import { logLine } from './host.ts'
import { JobManager } from './jobs.ts'
import type { AgentStatusPayload, JobTiming } from './jobs.ts'
import { LinkConnection } from './link.ts'
import type { LinkStatus, SocketLike, Timing } from './link.ts'
import { Store, TokenVault, toProjectRefs } from './store.ts'
import type { AllowedProject, LinkRecord } from './store.ts'
import { errorCode, errorMessage } from './util.ts'
import { LINK_ID } from './wire.ts'
import type { ProjectRef } from './wire.ts'

export interface PluginDeps {
  host: HostPort
  pluginVersion: string
  platform: string
  hostname: string
  newId: () => string
  newSocket: (url: string) => SocketLike
  fetchFn: typeof fetch
  exec?: ExecFn
  timing: Timing
  jobTiming: JobTiming
  random: () => number
  now: () => number
  postState: (state: PanelState) => void
}

export type LinkView = {
  link_id: string
  bot_label: string
  host_label: string
  status: LinkStatus
  last_error: string | null
  active_jobs: number
  projects: AllowedProject[]
  /** "Allow all projects" is on: `projects` is then not the limit. */
  allow_all_projects: boolean
  link_name: string | null
  token_in_storage: boolean
}

export interface PanelState {
  protection: 'os-keyring' | 'unavailable'
  allow_without_keyring: boolean
  /** At least one token sits in `storage` because there is no OS key store. */
  token_without_keyring: boolean
  cli: { available: boolean; path: string | null }
  service_url: string
  service_url_valid: boolean
  installation: string
  plugin_version: string
  default_host_label: string
  links: LinkView[]
}

export type PairError =
  | 'invalid_code'
  | 'already_linked'
  | 'rate_limited'
  | 'network'
  | 'server_error'
  | 'keyring_unavailable'
  | 'bad_service_url'
  | 'bad_input'
  | 'storage_failed'

export type PairResult = { ok: true; link_id: string } | { ok: false; error: PairError }

const MAX_RESPONSE = 64 * 1024
/** Most projects announced to the service in one message. */
export const MAX_ANNOUNCED_PROJECTS = 500

export class Plugin {
  readonly store: Store
  readonly vault: TokenVault
  readonly cli: OrcaCli
  readonly jobs: JobManager
  private conns = new Map<string, LinkConnection>()
  private notifyQueued = false
  private projectsTimer: ReturnType<typeof setInterval> | null = null
  private refreshing = false
  private refreshAgain = false
  /** What each link was last told (as JSON), so "allow all" only re-sends on a real change. */
  private announced = new Map<string, string>()
  private disposed = false

  private d: PluginDeps

  constructor(d: PluginDeps) {
    this.d = d
    this.store = new Store(d.host)
    this.vault = new TokenVault(d.host, async () => (await this.settings()).allowTokenWithoutKeyring === true)
    this.cli = new OrcaCli(
      async () => {
        const p = (await this.settings()).orcaCliPath
        return typeof p === 'string' && p.trim() ? p.trim() : undefined
      },
      d.exec,
      d.now
    )
    this.jobs = new JobManager({
      host: d.host,
      store: this.store,
      cli: this.cli,
      timing: d.jobTiming,
      now: d.now,
      eligibleProjects: () => this.eligibleProjects(),
      publish: (linkId, event) => this.publish(linkId, event),
      changed: () => this.changed()
    })
  }

  private async settings(): Promise<Record<string, unknown>> {
    try {
      return await this.d.host.settings.get()
    } catch {
      return {}
    }
  }

  private log(event: string, fields: Record<string, unknown> = {}): void {
    logLine(this.d.host, event, fields)
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  async start(): Promise<void> {
    await this.store.load(this.d.newId)
    this.jobs.init()
    for (const link of this.store.links) if (!link.revoked) await this.connect(link)
    this.changed()
    void this.jobs.reconcile()
    this.projectsTimer = setInterval(() => void this.refreshAllProjects(), this.d.timing.projectsPollMs)
  }

  dispose(): void {
    this.disposed = true
    if (this.projectsTimer) clearInterval(this.projectsTimer)
    this.projectsTimer = null
    for (const c of this.conns.values()) c.stop(false)
    this.conns.clear()
    this.jobs.dispose()
  }

  // ---- connections ---------------------------------------------------------------------------

  private async connect(link: LinkRecord): Promise<void> {
    const token = await this.vault.get(link)
    const endpoints = resolveEndpoints(link.service_url)
    if (!token || !endpoints) {
      this.log('link.cannot_connect', { link_id: link.link_id, reason: token ? 'bad_url' : 'no_token' })
      return
    }
    const conn = new LinkConnection({
      linkId: link.link_id,
      wsUrl: endpoints.wsUrl,
      token,
      host: this.d.host,
      store: this.store,
      timing: this.d.timing,
      random: this.d.random,
      newSocket: this.d.newSocket,
      pluginVersion: this.d.pluginVersion,
      platform: this.d.platform,
      helloInfo: async () => {
        const cli = await this.cli.resolve()
        return { orca_version: cli?.orcaVersion ?? 'unknown', capabilities: cli ? ['send.cli'] : [] }
      },
      projectRefs: () => this.projectRefsOf(link.link_id),
      onWelcome: (info) => this.onWelcome(link.link_id, info),
      onCommand: (name, args, limits) => this.jobs.handle(link.link_id, name, args, limits),
      onChange: () => this.changed(),
      onRevoked: (reason) => void this.onRevoked(link.link_id, reason)
    })
    this.conns.set(link.link_id, conn)
    conn.start()
  }

  private async onRevoked(linkId: string, _reason: string): Promise<void> {
    const link = this.store.link(linkId)
    if (!link) return
    this.conns.delete(linkId)
    this.jobs.forgetLink(linkId)
    await this.vault.delete(linkId)
    link.revoked = true
    link.token_in_storage = false
    this.store.clearOutbox(linkId)
    await this.store.saveLinks()
    this.changed()
  }

  private publish(linkId: string, event: Parameters<LinkConnection['publish']>[0]): void {
    const conn = this.conns.get(linkId)
    if (conn) conn.publish(event)
    else this.store.enqueue(linkId, event)
  }

  // ---- panel API -----------------------------------------------------------------------------

  async getState(): Promise<PanelState> {
    const settings = await this.settings()
    const endpoints = resolveEndpoints(typeof settings.serviceUrl === 'string' ? settings.serviceUrl : undefined)
    const cli = await this.cli.resolve()
    const links: LinkView[] = this.store.links.map((l) => ({
      link_id: l.link_id,
      bot_label: l.bot_label,
      host_label: l.host_label,
      status: l.revoked ? 'revoked' : (this.conns.get(l.link_id)?.status ?? 'no_token'),
      last_error: this.conns.get(l.link_id)?.lastError ?? null,
      active_jobs: this.jobs.activeCount(l.link_id),
      projects: l.allowed_projects,
      allow_all_projects: l.allow_all_projects === true,
      link_name: l.link_name ?? null,
      token_in_storage: Boolean(l.token_in_storage)
    }))
    return {
      protection: await this.vault.protection(),
      allow_without_keyring: settings.allowTokenWithoutKeyring === true,
      token_without_keyring: this.store.links.some((l) => l.token_in_storage && !l.revoked),
      cli: { available: Boolean(cli), path: cli?.path ?? null },
      service_url: endpoints?.base ?? '',
      service_url_valid: Boolean(endpoints),
      installation: this.store.installationId.slice(0, 8),
      plugin_version: this.d.pluginVersion,
      default_host_label: this.d.hostname.slice(0, 80),
      links
    }
  }

  /** Coalesces bursts of changes into one push to the panel and one status bar update. */
  changed(): void {
    if (this.notifyQueued || this.disposed) return
    this.notifyQueued = true
    setTimeout(() => {
      this.notifyQueued = false
      void this.pushState()
    }, 20)
  }

  private async pushState(): Promise<void> {
    if (this.disposed) return
    try {
      const state = await this.getState()
      this.d.postState(state)
      await this.updateStatusBar(state)
    } catch (error) {
      this.log('state.push_failed', { error: errorMessage(error) })
    }
  }

  private async updateStatusBar(state: PanelState): Promise<void> {
    const live = state.links.filter((l) => l.status !== 'revoked')
    const online = live.filter((l) => l.status === 'online').length
    let text = 'CuriaBots'
    let tone = 'neutral'
    let tooltip = 'CuriaBots: no agent linked. Open the CuriaBots panel to link one.'
    if (live.length > 0) {
      if (online === live.length) {
        text = 'CuriaBots: online'
        tone = 'success'
        tooltip = `CuriaBots: ${online} link(s) online.`
      } else if (live.every((l) => l.status === 'connecting')) {
        text = 'CuriaBots: linked'
        tone = 'accent'
        tooltip = 'CuriaBots: linked, connecting.'
      } else {
        text = online > 0 ? `CuriaBots: ${online}/${live.length} online` : 'CuriaBots: offline'
        tone = 'warning'
        tooltip = `CuriaBots: ${online} of ${live.length} link(s) online.`
      }
    }
    let icon = 'plug'
    if (state.token_without_keyring) {
      text += ' · token without keyring'
      tone = 'warning'
      icon = 'warning'
      tooltip += ' Token stored without an OS keyring (opt-in setting).'
    }
    try {
      await this.d.host.call(M.statusBarUpdate, { id: 'curiabots', text, tone, icon, tooltip })
    } catch {
      /* the status bar is cosmetic */
    }
  }

  async pair(codeInput: string, hostLabelInput?: string): Promise<PairResult> {
    const code = typeof codeInput === 'string' ? codeInput.replace(/\s+/g, '') : ''
    if (!/^[A-Za-z0-9_-]{4,32}$/.test(code)) return { ok: false, error: 'bad_input' }
    const settings = await this.settings()
    const endpoints = resolveEndpoints(typeof settings.serviceUrl === 'string' ? settings.serviceUrl : undefined)
    if (!endpoints) return { ok: false, error: 'bad_service_url' }
    // Check before spending the one-time code: a link we cannot store safely is not worth making.
    if ((await this.vault.protection()) !== 'os-keyring' && settings.allowTokenWithoutKeyring !== true) {
      return { ok: false, error: 'keyring_unavailable' }
    }
    const hostLabel =
      (typeof hostLabelInput === 'string' ? hostLabelInput : '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80) ||
      this.d.hostname.slice(0, 80) ||
      'Orca'
    const cli = await this.cli.resolve()
    let response: Response
    let body: string
    try {
      response = await this.d.fetchFn(endpoints.pairUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          code,
          installation_id: this.store.installationId,
          plugin_version: this.d.pluginVersion,
          orca_version: cli?.orcaVersion ?? 'unknown',
          host_label: hostLabel
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(15_000)
      })
      body = (await response.text()).slice(0, MAX_RESPONSE)
    } catch (error) {
      this.log('pair.network_error', { error: errorMessage(error) })
      return { ok: false, error: 'network' }
    }
    this.log('pair.response', { status: response.status })
    if (response.status === 400) return { ok: false, error: 'invalid_code' }
    if (response.status === 409) return { ok: false, error: 'already_linked' }
    if (response.status === 429) return { ok: false, error: 'rate_limited' }
    if (response.status !== 200) return { ok: false, error: 'server_error' }
    let data: { link_id?: unknown; token?: unknown; bot_label?: unknown }
    try {
      data = JSON.parse(body)
    } catch {
      return { ok: false, error: 'server_error' }
    }
    const linkId = data.link_id
    const token = data.token
    if (
      typeof linkId !== 'string' ||
      !LINK_ID.test(linkId) ||
      typeof token !== 'string' ||
      !/^[A-Za-z0-9_-]{16,512}$/.test(token) ||
      this.store.link(linkId)
    ) {
      return { ok: false, error: 'server_error' }
    }
    let inStorage: boolean
    try {
      inStorage = (await this.vault.save(linkId, token)).inStorage
    } catch (error) {
      this.log('pair.store_failed', { error_code: errorCode(error) })
      return { ok: false, error: errorCode(error) === 'keyring_unavailable' ? 'keyring_unavailable' : 'storage_failed' }
    }
    const botLabel =
      typeof data.bot_label === 'string'
        ? data.bot_label.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80) || 'CuriaBots'
        : 'CuriaBots'
    const link: LinkRecord = {
      link_id: linkId,
      bot_label: botLabel,
      host_label: hostLabel,
      service_url: endpoints.base,
      allowed_projects: [],
      created_at: this.d.now(),
      ...(inStorage ? { token_in_storage: true } : {})
    }
    await this.store.addLink(link)
    this.log('link.created', { link_id: linkId, token_in_storage: inStorage })
    await this.connect(link)
    this.changed()
    return { ok: true, link_id: linkId }
  }

  async unlink(linkId: string): Promise<boolean> {
    const link = this.store.link(linkId)
    if (!link) return false
    const conn = this.conns.get(linkId)
    this.conns.delete(linkId)
    if (conn && !link.revoked) conn.stop(true)
    this.jobs.forgetLink(linkId)
    this.announced.delete(linkId)
    await this.vault.delete(linkId)
    await this.store.removeLink(linkId)
    this.log('link.removed', { link_id: linkId })
    this.changed()
    return true
  }

  /** Git projects Orca lists, local and SSH (hidden ones included: the panel lets you pick them). */
  async listProjects(): Promise<{ id: string; name: string; host_id: string; path: string; hidden: boolean }[]> {
    const res = (await this.d.host.call(M.projectList, {})) as {
      projects: { id: string; name: string; kind: string; hostId: string | null; path: string; hidden?: boolean }[]
    }
    return res.projects
      .filter((p) => p.kind === 'git' && typeof p.id === 'string' && typeof p.name === 'string')
      .map((p) => ({ id: p.id, name: p.name, host_id: p.hostId ?? 'local', path: p.path, hidden: p.hidden === true }))
  }

  /**
   * The projects "allow all" covers: every Git project in `project.list` that is not hidden. A project
   * the user hid in Orca stays out (hiding is the user's own "I do not work here"); it is still
   * reachable through the explicit list. Never anything that `project.list` does not return.
   */
  async eligibleProjects(): Promise<{ id: string; name: string; host_id: string }[]> {
    return (await this.listProjects())
      .filter((p) => !p.hidden)
      .slice(0, MAX_ANNOUNCED_PROJECTS)
      .map((p) => ({ id: p.id, name: p.name, host_id: p.host_id }))
  }

  /** What to tell the service for a link: the explicit list, or Orca's whole list in "allow all" mode. */
  private async projectRefsOf(linkId: string): Promise<ProjectRef[]> {
    const link = this.store.link(linkId)
    if (!link) return []
    if (link.allow_all_projects !== true) return toProjectRefs(link.allowed_projects)
    let refs: ProjectRef[]
    try {
      refs = toProjectRefs(await this.eligibleProjects())
    } catch (error) {
      // Orca refused the listing for a moment: repeat the last list rather than drop the link or send none.
      this.log('projects.list_failed', { link_id: linkId, error: errorMessage(error) })
      const last = this.announced.get(linkId)
      return last ? (JSON.parse(last) as ProjectRef[]) : []
    }
    this.announced.set(linkId, JSON.stringify(refs))
    return refs
  }

  /**
   * "Allow all" keeps the service's list current: a new `projects` message goes out whenever Orca's
   * list differs from what the link was last told. Runs on `workspace.created` / `workspace.removed`
   * and every `projectsPollMs` (a project added without a workspace raises no event), and `start_job`
   * always re-reads the list itself, so a stale announcement never widens what can be started.
   */
  async refreshAllProjects(): Promise<void> {
    if (this.disposed) return
    if (this.refreshing) {
      this.refreshAgain = true
      return
    }
    this.refreshing = true
    try {
      do {
        this.refreshAgain = false
        for (const link of this.store.links) {
          if (link.allow_all_projects !== true || link.revoked) continue
          const conn = this.conns.get(link.link_id)
          if (!conn?.isOnline) continue
          let refs: ProjectRef[]
          try {
            refs = toProjectRefs(await this.eligibleProjects())
          } catch (error) {
            this.log('projects.list_failed', { link_id: link.link_id, error: errorMessage(error) })
            continue
          }
          const signature = JSON.stringify(refs)
          if (this.announced.get(link.link_id) === signature) continue
          if (await conn.sendProjects()) this.log('projects.refreshed', { link_id: link.link_id, count: refs.length })
        }
      } while (this.refreshAgain && !this.disposed)
    } finally {
      this.refreshing = false
    }
  }

  private onWelcome(linkId: string, info: { bot_label?: string; link_name?: string }): void {
    const link = this.store.link(linkId)
    if (!link) return
    const nextLabel = info.bot_label ?? link.bot_label
    if (nextLabel === link.bot_label && info.link_name === link.link_name) return
    link.bot_label = nextLabel
    if (info.link_name) link.link_name = info.link_name
    else delete link.link_name
    void this.store.saveLinks()
    this.changed()
  }

  /** Turns "allow all projects" on or off for a link. Off goes back to the explicit list, kept as it was. */
  async setAllowAll(linkId: string, on: boolean): Promise<boolean> {
    const link = this.store.link(linkId)
    if (!link || link.revoked) return false
    link.allow_all_projects = on === true
    await this.store.saveLinks()
    this.announced.delete(linkId)
    void this.conns.get(linkId)?.sendProjects()
    this.log('projects.allow_all', { link_id: linkId, on: link.allow_all_projects })
    this.changed()
    return true
  }

  /** Replaces the allowed projects of a link with those of `wanted` that Orca really lists. */
  async setProjects(linkId: string, wanted: { id: string; host_id: string }[]): Promise<boolean> {
    const link = this.store.link(linkId)
    if (!link || link.revoked) return false
    const known = await this.listProjects()
    const allowed: AllowedProject[] = []
    for (const w of wanted) {
      const match = known.find((k) => k.id === w.id && k.host_id === w.host_id)
      if (match && !allowed.some((a) => a.id === match.id && a.host_id === match.host_id)) {
        allowed.push({ id: match.id, host_id: match.host_id, name: match.name })
      }
    }
    link.allowed_projects = allowed
    await this.store.saveLinks()
    this.announced.delete(linkId)
    void this.conns.get(linkId)?.sendProjects()
    this.log('projects.set', { link_id: linkId, count: allowed.length })
    this.changed()
    return true
  }

  // ---- Orca events ---------------------------------------------------------------------------

  onAgentStatus(payload: AgentStatusPayload): void {
    this.jobs.onAgentStatus(payload)
  }
  onWorkspaceRemoved(payload: { workspaceId?: string; workspaceListId?: string }): void {
    this.jobs.onWorkspaceRemoved(payload)
    void this.refreshAllProjects()
  }
  onWorkspaceCreated(): void {
    void this.refreshAllProjects()
  }
}
