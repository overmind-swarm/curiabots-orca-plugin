// Persistent state: links, jobs and the event outbox live in `storage`; tokens in `secrets`
// (or, only if the user opted in and there is no OS key store, in `storage`).
import { M } from './methods.ts'
import type { HostPort } from './host.ts'
import { logLine } from './host.ts'
import { clone, errorMessage } from './util.ts'
import type { JobEvent, OrcaState, ProjectRef } from './wire.ts'

export const MAX_OUTBOX = 500
export const MAX_CLOSED_JOBS = 200
/** Terminal events are never dropped for being old, only past this absolute bound (a server that never acks). */
export const HARD_MAX_OUTBOX = 2000

export interface AllowedProject {
  id: string
  host_id: string
  name: string
}

export interface LinkRecord {
  link_id: string
  bot_label: string
  /** Label of this computer shown on the skill's card. */
  host_label: string
  /** Base URL fixed when the link was made, so a later settings change never redirects a token. */
  service_url: string
  allowed_projects: AllowedProject[]
  /**
   * "Allow all projects": the link may use every Git project Orca lists (not hidden), including ones
   * added later, and `allowed_projects` is ignored. Absent in links saved before 0.2.0 = false.
   */
  allow_all_projects?: boolean
  /**
   * The service may ask this Orca to clone a Git repository into the clone folder of the settings and add it as a
   * project (`add_project`, dev#2424). Off by default and absent in links saved before 0.9.0 = false. It never allows
   * the new project: that stays the user's own choice (or "allow all projects").
   */
  allow_add_projects?: boolean
  /** Name of the link in CuriaBots, if the server sent it in `welcome`. */
  link_name?: string
  created_at: number
  /** The skill revoked it; the token is gone and only "remove" is left. */
  revoked?: boolean
  /** The token lives in `storage` because the user allowed it without an OS key store. */
  token_in_storage?: boolean
}

export interface JobRecord {
  job_id: string
  link_id: string
  project_id: string
  host_id: string
  workspace_id: string | null
  terminal_id: string | null
  session_id: string | null
  /** `creating` while workspace.create runs; a stale one after a restart is never trusted. */
  phase: 'creating' | 'running' | 'stopped' | 'gone' | 'failed'
  orca_state: OrcaState | null
  outcome: string | null
  /** What the job was last reported as, with a hash of the excerpt sent: the pair is what dedupes. */
  last_emitted: string | null
  last_hash: string | null
  agent: string
  created_at: number
  updated_at: number
}

export interface OutboxEntry {
  seq: number
  event: JobEvent
}
export interface OutboxData {
  next_seq: number
  events: OutboxEntry[]
}

export type KeyProtection = 'os-keyring' | 'unavailable'

export class Store {
  installationId = ''
  links: LinkRecord[] = []
  private jobs = new Map<string, Record<string, JobRecord>>()
  private outboxes = new Map<string, OutboxData>()
  private chains = new Map<string, Promise<void>>()

  private host: HostPort

  constructor(host: HostPort) {
    this.host = host
  }

  async load(newId: () => string): Promise<void> {
    const id = await this.host.storage.get('installation_id')
    if (typeof id === 'string' && id.length >= 8) this.installationId = id
    else {
      this.installationId = newId()
      await this.host.storage.set('installation_id', this.installationId)
    }
    const links = await this.host.storage.get('links')
    this.links = Array.isArray(links) ? (links as LinkRecord[]) : []
    // Links saved by 0.1.x have no flag: they keep their explicit list (migration is the default).
    for (const link of this.links) {
      link.allow_all_projects = link.allow_all_projects === true
      link.allow_add_projects = link.allow_add_projects === true
      if (!Array.isArray(link.allowed_projects)) link.allowed_projects = []
    }
    for (const link of this.links) {
      const jobs = await this.host.storage.get(`jobs:${link.link_id}`)
      this.jobs.set(link.link_id, jobs && typeof jobs === 'object' ? (jobs as Record<string, JobRecord>) : {})
      const outbox = await this.host.storage.get(`outbox:${link.link_id}`)
      this.outboxes.set(link.link_id, normalizeOutbox(outbox))
    }
  }

  /** Writes the latest value of `key`, one write at a time, so a stale write never wins. */
  private persist(key: string, value: () => unknown): Promise<void> {
    const prev = this.chains.get(key) ?? Promise.resolve()
    const next = prev.then(async () => {
      try {
        await this.host.storage.set(key, clone(value()))
      } catch (error) {
        logLine(this.host, 'storage.write_failed', { key, error: errorMessage(error) })
      }
    })
    this.chains.set(key, next)
    return next
  }

  saveLinks(): Promise<void> {
    return this.persist('links', () => this.links)
  }

  link(linkId: string): LinkRecord | undefined {
    return this.links.find((l) => l.link_id === linkId)
  }

  async addLink(link: LinkRecord): Promise<void> {
    this.links.push(link)
    this.jobs.set(link.link_id, {})
    this.outboxes.set(link.link_id, { next_seq: 1, events: [] })
    await this.saveLinks()
  }

  async removeLink(linkId: string): Promise<void> {
    this.links = this.links.filter((l) => l.link_id !== linkId)
    this.jobs.delete(linkId)
    this.outboxes.delete(linkId)
    await this.saveLinks()
    await this.chains.get(`jobs:${linkId}`)
    await this.chains.get(`outbox:${linkId}`)
    await this.host.storage.delete(`jobs:${linkId}`).catch(() => undefined)
    await this.host.storage.delete(`outbox:${linkId}`).catch(() => undefined)
    this.chains.delete(`jobs:${linkId}`)
    this.chains.delete(`outbox:${linkId}`)
  }

  jobsOf(linkId: string): Record<string, JobRecord> {
    let jobs = this.jobs.get(linkId)
    if (!jobs) {
      jobs = {}
      this.jobs.set(linkId, jobs)
    }
    return jobs
  }

  saveJobs(linkId: string): Promise<void> {
    this.pruneJobs(linkId) // closed and failed records are bounded however they came to be
    return this.persist(`jobs:${linkId}`, () => this.jobsOf(linkId))
  }

  pruneJobs(linkId: string): void {
    const jobs = this.jobsOf(linkId)
    const closed = Object.values(jobs)
      .filter((j) => j.phase === 'stopped' || j.phase === 'gone' || j.phase === 'failed')
      .sort((a, b) => a.updated_at - b.updated_at)
    for (const old of closed.slice(0, Math.max(0, closed.length - MAX_CLOSED_JOBS))) delete jobs[old.job_id]
  }

  outbox(linkId: string): OutboxData {
    let box = this.outboxes.get(linkId)
    if (!box) {
      box = { next_seq: 1, events: [] }
      this.outboxes.set(linkId, box)
    }
    return box
  }

  /** Appends an event and returns its sequence number; the oldest fall off past MAX_OUTBOX. */
  enqueue(linkId: string, event: JobEvent): OutboxEntry {
    const box = this.outbox(linkId)
    const entry = { seq: box.next_seq++, event }
    box.events.push(entry)
    if (box.events.length > MAX_OUTBOX) compactOutbox(box)
    void this.persist(`outbox:${linkId}`, () => this.outbox(linkId))
    return entry
  }

  ack(linkId: string, seq: number): void {
    const box = this.outbox(linkId)
    const before = box.events.length
    box.events = box.events.filter((e) => e.seq !== seq)
    if (box.events.length !== before) void this.persist(`outbox:${linkId}`, () => this.outbox(linkId))
  }

  clearOutbox(linkId: string): void {
    const box = this.outbox(linkId)
    box.events = []
    void this.persist(`outbox:${linkId}`, () => this.outbox(linkId))
  }

  async flush(): Promise<void> {
    await Promise.all([...this.chains.values()])
  }
}

function isTerminal(event: JobEvent): boolean {
  return event.kind === 'job.gone' || event.state === 'failed' || event.state === 'stopped'
}

/**
 * Past MAX_OUTBOX: keep only the last job.status of each job; terminal events are never dropped.
 * If that is still too many, the oldest non-terminal ones go first.
 */
export function compactOutbox(box: OutboxData): void {
  const last = new Map<string, number>()
  box.events.forEach((e, i) => {
    if (e.event.kind === 'job.status') last.set(e.event.job_id, i)
  })
  box.events = box.events.filter((e, i) => isTerminal(e.event) || last.get((e.event as { job_id: string }).job_id) === i)
  let excess = box.events.length - MAX_OUTBOX
  if (excess > 0) {
    box.events = box.events.filter((e) => {
      if (excess > 0 && !isTerminal(e.event)) {
        excess--
        return false
      }
      return true
    })
  }
  if (box.events.length > MAX_OUTBOX) {
    // Only terminal events are left: they keep their state but no longer hold terminal output.
    for (const e of box.events) if (e.event.kind === 'job.status') (delete e.event.excerpt, delete e.event.options)
    if (box.events.length > HARD_MAX_OUTBOX) box.events.splice(0, box.events.length - HARD_MAX_OUTBOX)
  }
}

function normalizeOutbox(raw: unknown): OutboxData {
  const box = raw as Partial<OutboxData> | null
  const events = Array.isArray(box?.events) ? box.events.filter((e) => e && Number.isSafeInteger(e.seq) && e.event) : []
  const maxSeq = events.reduce((m, e) => Math.max(m, e.seq), 0)
  const next = Number.isSafeInteger(box?.next_seq) ? Number(box?.next_seq) : 1
  return { next_seq: Math.max(next, maxSeq + 1), events }
}

/** Where the link tokens live; never logs a token. */
export class TokenVault {
  private host: HostPort
  private allowWithoutKeyring: () => Promise<boolean>

  constructor(host: HostPort, allowWithoutKeyring: () => Promise<boolean>) {
    this.host = host
    this.allowWithoutKeyring = allowWithoutKeyring
  }

  async protection(): Promise<KeyProtection> {
    try {
      const result = (await this.host.call(M.secretsProtection, {})) as { status?: string }
      return result?.status === 'os-keyring' ? 'os-keyring' : 'unavailable'
    } catch {
      return 'unavailable'
    }
  }

  /** Stores a token and says where it went; throws `keyring_unavailable` when it may not. */
  async save(linkId: string, token: string): Promise<{ inStorage: boolean }> {
    if ((await this.protection()) === 'os-keyring') {
      await this.host.secrets.set(`link:${linkId}`, token)
      return { inStorage: false }
    }
    if (!(await this.allowWithoutKeyring())) {
      throw Object.assign(new Error('no OS key store and token storage without it is not allowed'), {
        code: 'keyring_unavailable'
      })
    }
    await this.host.storage.set(`token:${linkId}`, token)
    return { inStorage: true }
  }

  async get(link: LinkRecord): Promise<string | null> {
    try {
      if (link.token_in_storage) {
        const value = await this.host.storage.get(`token:${link.link_id}`)
        return typeof value === 'string' && value ? value : null
      }
      return (await this.host.secrets.get(`link:${link.link_id}`)) || null
    } catch {
      return null
    }
  }

  async delete(linkId: string): Promise<void> {
    await this.host.secrets.delete(`link:${linkId}`).catch(() => undefined)
    await this.host.storage.delete(`token:${linkId}`).catch(() => undefined)
  }
}

export function toProjectRefs(allowed: readonly AllowedProject[]): ProjectRef[] {
  return allowed.map((p) => ({ id: p.id, name: p.name, host_id: p.host_id }))
}
