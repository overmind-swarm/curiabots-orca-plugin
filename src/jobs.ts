// Jobs: the five commands of the contract, strictly scoped to the link that started each job, and
// the stabilised job.status events that come from Orca's agent status changes.
import type { OrcaCli } from './cli.ts'
import { M } from './methods.ts'
import type { HostPort } from './host.ts'
import { logLine } from './host.ts'
import type { JobRecord, Store } from './store.ts'
import { boundLines, errorCode, errorMessage } from './util.ts'
import { buildExcerpt, normalizeExcerpt } from './excerpt.ts'
import { detectOptions } from './options.ts'
import type { ScreenOption } from './options.ts'
import type { CommandResult } from './link.ts'
import { createHash } from 'node:crypto'
import type { ErrorCode, JobEvent, JobState, Limits, OrcaState } from './wire.ts'
import { MAX_PROMPT_BYTES, isCommandName, mapState, validateArgs } from './wire.ts'

export const LOCAL_MAX_JOBS_PER_LINK = 5
export const LOCAL_MAX_JOBS_TOTAL = 10
const EXCERPT_STATES = new Set<JobState>(['waiting_user', 'idle', 'failed', 'stopped'])
const ORCA_STATES = new Set(['working', 'blocked', 'waiting', 'done'])

export interface JobTiming {
  stabilizeMs: number
  reconcileMs: number
  /** Jobs younger than this are not reconciled (Orca may not list their terminal yet). */
  graceMs: number
}
export const DEFAULT_JOB_TIMING: JobTiming = { stabilizeMs: 5000, reconcileMs: 60_000, graceMs: 15_000 }

export interface AgentStatusPayload {
  terminalId?: string
  state?: string
  sessionId?: string
  mainAgent?: { state?: string; outcome?: string }
}

export interface JobManagerDeps {
  host: HostPort
  store: Store
  cli: OrcaCli
  timing: JobTiming
  now: () => number
  /** Git projects Orca lists now (not hidden); used by links with "allow all projects". */
  eligibleProjects: () => Promise<{ id: string; name: string; host_id: string }[]>
  publish: (linkId: string, event: JobEvent) => void
  changed: () => void
}

const fail = (code: ErrorCode, message: string, details?: Record<string, unknown>): CommandResult => ({
  ok: false,
  error: details ? { code, message, details } : { code, message }
})

function mapHostError(error: unknown): CommandResult {
  const code = errorCode(error)
  const message = errorMessage(error)
  switch (code) {
    case 'unavailable':
    case 'capability_denied':
    case 'consent_required':
    case 'not_permitted':
    case 'unknown_method':
      return fail('orca_unavailable', message)
    case 'timeout':
      return fail('timeout', message)
    case 'invalid_params':
    case 'invalid_request':
      return fail('invalid_args', message)
    case 'cli_unavailable':
      return fail('cli_unavailable', message)
    // Already codes of the contract (thrown by the CLI wrapper with a message that helps).
    case 'forbidden':
    case 'not_found':
    case 'orca_unavailable':
    case 'invalid_args':
    case 'needs_option':
      return fail(code, message)
    default:
      return fail('internal', message)
  }
}

export class JobManager {
  private byTerminal = new Map<string, { linkId: string; jobId: string }>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private inflight = new Map<string, Promise<CommandResult>>()
  private reconcileTimer: ReturnType<typeof setInterval> | null = null

  private d: JobManagerDeps

  constructor(d: JobManagerDeps) {
    this.d = d
  }

  init(): void {
    for (const link of this.d.store.links) {
      for (const job of Object.values(this.d.store.jobsOf(link.link_id))) {
        if (job.phase === 'running' && job.terminal_id) {
          this.byTerminal.set(job.terminal_id, { linkId: link.link_id, jobId: job.job_id })
        }
      }
    }
    this.reconcileTimer = setInterval(() => void this.reconcile(), this.d.timing.reconcileMs)
  }

  dispose(): void {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer)
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }

  /** Forgets a link's jobs locally (the agents keep running in Orca). */
  forgetLink(linkId: string): void {
    for (const [terminal, ref] of [...this.byTerminal]) if (ref.linkId === linkId) this.byTerminal.delete(terminal)
    for (const job of Object.values(this.d.store.jobsOf(linkId))) {
      const t = this.timers.get(job.job_id)
      if (t) clearTimeout(t)
      this.timers.delete(job.job_id)
    }
  }

  activeCount(linkId?: string): number {
    let n = 0
    for (const link of this.d.store.links) {
      if (linkId && link.link_id !== linkId) continue
      for (const job of Object.values(this.d.store.jobsOf(link.link_id))) {
        if (job.phase === 'creating' || job.phase === 'running') n++
      }
    }
    return n
  }

  private log(event: string, fields: Record<string, unknown> = {}): void {
    logLine(this.d.host, event, fields)
  }

  // ---- commands -----------------------------------------------------------------------------

  async handle(linkId: string, name: string, rawArgs: unknown, limits: Limits): Promise<CommandResult> {
    if (!isCommandName(name)) return fail('invalid_args', 'unknown command')
    const maxPrompt = Math.min(limits.max_prompt_bytes ?? MAX_PROMPT_BYTES, MAX_PROMPT_BYTES)
    const checked = validateArgs(name, rawArgs, maxPrompt)
    if (!checked.ok) return fail('invalid_args', checked.message)
    this.log('command', { link_id: linkId, name })
    switch (name) {
      case 'start_job':
        return this.startJob(linkId, checked.value as any, limits)
      case 'get_job':
        return this.getJob(linkId, (checked.value as any).job_id)
      case 'read_output':
        return this.readOutput(linkId, (checked.value as any).job_id, (checked.value as any).tail_lines)
      case 'send':
        return this.send(linkId, checked.value as any)
      case 'stop':
        return this.stop(linkId, (checked.value as any).job_id)
    }
  }

  /** The job, only if `linkId` started it. */
  private own(linkId: string, jobId: string): { job: JobRecord } | { error: CommandResult } {
    const jobs = this.d.store.jobsOf(linkId)
    if (Object.hasOwn(jobs, jobId)) return { job: jobs[jobId]! }
    for (const link of this.d.store.links) {
      if (link.link_id !== linkId && Object.hasOwn(this.d.store.jobsOf(link.link_id), jobId)) {
        this.log('forbidden', { link_id: linkId })
        return { error: fail('forbidden', 'the job belongs to another link') }
      }
    }
    return { error: fail('not_found', 'unknown job') }
  }

  private async startJob(linkId: string, a: any, limits: Limits): Promise<CommandResult> {
    const link = this.d.store.link(linkId)
    if (!link) return fail('forbidden', 'unknown link')
    const matches = (p: { id: string; host_id: string }) =>
      p.id === a.project_id && (a.host_id === undefined || p.host_id === a.host_id)
    let allowed: { id: string; host_id: string } | undefined
    if (link.allow_all_projects === true) {
      // Always checked against Orca's live list: any project it lists, nothing it does not.
      try {
        allowed = (await this.d.eligibleProjects()).find(matches)
      } catch (error) {
        this.log('start_job.rejected', { link_id: linkId, reason: 'list_failed' })
        return mapHostError(error)
      }
    } else {
      allowed = link.allowed_projects.find(matches)
    }
    if (!allowed) {
      this.log('start_job.rejected', { link_id: linkId, reason: 'project_not_allowed' })
      return fail('forbidden', 'the project is not allowed for this link')
    }
    const key = `${linkId}:${a.job_id}`
    if (this.inflight.has(key)) return fail('in_progress', 'this job is still being started')
    const run = this.runStart(linkId, a, allowed.host_id, limits).finally(() => this.inflight.delete(key))
    this.inflight.set(key, run)
    return run
  }

  private async runStart(linkId: string, a: any, hostId: string, limits: Limits): Promise<CommandResult> {
    const own = this.own(linkId, a.job_id)
    if ('job' in own) {
      const job = own.job
      if (job.phase === 'creating') {
        // In progress in this very run, or left by a previous run of the worker that died mid-way:
        // never guess whether the worktree exists, never create a second one.
        if (this.inflight.has(`${linkId}:${job.job_id}`)) return fail('in_progress', 'this job is still being started')
        job.phase = 'failed'
        job.updated_at = this.d.now()
        await this.d.store.saveJobs(linkId)
        return fail('failed', 'a previous start of this job was interrupted')
      }
      if (job.phase === 'failed') return fail('failed', 'this job failed to start; use a new job_id')
      return { ok: true, data: startData(job) }
    }
    if (own.error.ok === false && own.error.error.code === 'forbidden') return own.error

    const maxPerLink = Math.min(limits.max_jobs ?? LOCAL_MAX_JOBS_PER_LINK, LOCAL_MAX_JOBS_PER_LINK)
    if (this.activeCount(linkId) >= maxPerLink || this.activeCount() >= LOCAL_MAX_JOBS_TOTAL) {
      this.log('start_job.rejected', { link_id: linkId, reason: 'limit' })
      return fail('limit_reached', 'too many active jobs')
    }

    const now = this.d.now()
    const job: JobRecord = {
      job_id: a.job_id,
      link_id: linkId,
      project_id: a.project_id,
      host_id: hostId,
      workspace_id: null,
      terminal_id: null,
      session_id: null,
      phase: 'creating',
      orca_state: null,
      outcome: null,
      last_emitted: null,
      last_hash: null,
      agent: a.agent,
      created_at: now,
      updated_at: now
    }
    const jobs = this.d.store.jobsOf(linkId)
    jobs[job.job_id] = job
    await this.d.store.saveJobs(linkId)
    try {
      const params: Record<string, unknown> = {
        projectId: a.project_id,
        hostId,
        name: a.workspace_name,
        agent: a.agent,
        prompt: a.prompt
      }
      if (a.base_branch) params.baseBranch = a.base_branch
      // `model` has no counterpart in workspace.create (host API 1.10): the agent uses its own default.
      const created = (await this.d.host.call(M.workspaceCreate, params)) as {
        workspaceId?: string
        terminalId?: string
      }
      if (!created?.workspaceId || !created.terminalId) {
        job.phase = 'failed'
        await this.d.store.saveJobs(linkId)
        return fail('internal', 'Orca did not start the agent')
      }
      job.workspace_id = created.workspaceId
      job.terminal_id = created.terminalId
      job.phase = 'running'
      job.updated_at = this.d.now()
      this.byTerminal.set(created.terminalId, { linkId, jobId: job.job_id })
      await this.d.store.saveJobs(linkId)
      this.log('job.started', { link_id: linkId, job_id: job.job_id, prompt_bytes: Buffer.byteLength(a.prompt) })
      this.d.changed()
      return { ok: true, data: startData(job) }
    } catch (error) {
      job.phase = 'failed'
      job.updated_at = this.d.now()
      await this.d.store.saveJobs(linkId)
      this.log('job.start_failed', { link_id: linkId, job_id: job.job_id, error_code: errorCode(error), error: errorMessage(error) })
      return mapHostError(error)
    }
  }

  private async currentOrcaState(job: JobRecord): Promise<OrcaState | null> {
    if (job.phase !== 'running' || !job.workspace_id) return job.orca_state
    try {
      const { agents } = (await this.d.host.call(M.agentsList, { workspaceId: job.workspace_id })) as {
        agents: { terminalId: string | null; state: string }[]
      }
      const mine = agents.find((x) => x.terminalId === job.terminal_id)
      if (mine && ORCA_STATES.has(mine.state)) return mine.state as OrcaState
    } catch {
      /* fall back to the last known state */
    }
    return job.orca_state
  }

  private async readScreen(job: JobRecord): Promise<{ excerpt: string; options: ScreenOption[] } | undefined> {
    if (!job.terminal_id) return undefined
    try {
      const { lines } = (await this.d.host.call(M.terminalRead, { terminalId: job.terminal_id, maxLines: 400 })) as {
        lines: string[]
      }
      return { excerpt: buildExcerpt(lines), options: detectOptions(lines) }
    } catch {
      return undefined
    }
  }

  private async readExcerpt(job: JobRecord): Promise<string | undefined> {
    return (await this.readScreen(job))?.excerpt
  }

  private async getJob(linkId: string, jobId: string): Promise<CommandResult> {
    const own = this.own(linkId, jobId)
    if ('error' in own) return own.error
    const job = own.job
    const orca = await this.currentOrcaState(job)
    const closed = job.phase === 'stopped' || job.phase === 'gone' || job.phase === 'failed'
    const state: JobState =
      job.phase === 'failed' ? 'failed' : closed ? 'stopped' : orca ? mapState(orca, job.outcome ?? undefined) : 'unknown'
    const screen = closed ? undefined : await this.readScreen(job)
    const excerpt = screen?.excerpt ?? ''
    const data: Record<string, unknown> = {
      state,
      orca_state: orca ?? 'unknown',
      excerpt,
      updated_at: job.updated_at
    }
    if (job.outcome) data.outcome = job.outcome
    if (state === 'waiting_user' && screen?.options.length) data.options = screen.options
    return { ok: true, data }
  }

  private async readOutput(linkId: string, jobId: string, tail: number): Promise<CommandResult> {
    const own = this.own(linkId, jobId)
    if ('error' in own) return own.error
    const job = own.job
    if (job.phase !== 'running' || !job.terminal_id) return fail('not_found', 'the job is not running')
    try {
      const out = (await this.d.host.call(M.terminalRead, { terminalId: job.terminal_id, maxLines: tail })) as {
        lines: string[]
        truncated: boolean
      }
      const bounded = boundLines(out.lines.slice(-tail))
      return { ok: true, data: { lines: bounded.lines, truncated: Boolean(out.truncated) || bounded.truncated } }
    } catch (error) {
      return mapHostError(error)
    }
  }

  private async send(linkId: string, a: { job_id: string; text?: string; enter?: boolean; option?: number }): Promise<CommandResult> {
    const own = this.own(linkId, a.job_id)
    if ('error' in own) return own.error
    const job = own.job
    if (job.phase !== 'running' || !job.terminal_id) return fail('not_found', 'the job is not running')
    // Writing into a user's terminal from the cloud is the delicate operation: prove it is safe.
    const orca = await this.currentOrcaState(job)
    if (orca !== 'waiting' && orca !== 'done') {
      this.log('send.refused', { link_id: linkId, job_id: job.job_id, reason: orca ?? 'unknown_state' })
      return fail(
        'forbidden',
        orca === 'blocked' ? 'the agent asks for a permission: resolve it in Orca' : 'the agent is not waiting for input'
      )
    }
    try {
      const shown = await this.d.cli.show(job.terminal_id)
      if (shown.agentIdentity?.toLowerCase() !== String(job.agent ?? '').toLowerCase() || !shown.connected || !shown.writable) {
        this.log('send.refused', { link_id: linkId, job_id: job.job_id, reason: 'terminal_not_agent' })
        return fail('forbidden', 'the terminal is not running the job\'s agent')
      }
    } catch (error) {
      if (errorCode(error) === 'cli_unavailable') return mapHostError(error)
      return fail('forbidden', 'could not verify the terminal')
    }
    try {
      // An option is a digit alone, never followed by Enter: the selector takes it as the choice.
      if (a.option !== undefined) await this.d.cli.send(job.terminal_id, String(a.option), false)
      else await this.d.cli.send(job.terminal_id, a.text ?? '', a.enter === true)
      // A reply starts a new turn: its stable end is worth a notice even if it equals the last one.
      job.last_emitted = null
      job.last_hash = null
      void this.d.store.saveJobs(linkId)
      this.log('send', { link_id: linkId, job_id: job.job_id, text_bytes: Buffer.byteLength(a.text ?? ''), option: a.option })
      return { ok: true, data: { accepted: true } }
    } catch (error) {
      const cliCode = (error as { cliCode?: unknown }).cliCode
      if (typeof cliCode === 'string') this.log('send.cli_error', { link_id: linkId, job_id: job.job_id, error_code: cliCode })
      if (errorCode(error) === 'needs_option' && a.option === undefined) {
        // Typing into a selector is not reliable and is not retried: say which numbers it takes.
        const options = (await this.readScreen(job))?.options ?? []
        return fail('needs_option', 'the agent shows a selector: answer with the number of an option', { options })
      }
      if (errorCode(error) === 'needs_option') return fail('forbidden', 'the agent did not accept the option')
      return mapHostError(error)
    }
  }

  private async stop(linkId: string, jobId: string): Promise<CommandResult> {
    const own = this.own(linkId, jobId)
    if ('error' in own) return own.error
    const job = own.job
    if (job.phase !== 'running' || !job.terminal_id) return { ok: true, data: { stopped: true } }
    const excerpt = await this.readExcerpt(job)
    try {
      await this.d.host.call(M.terminalClose, { terminalId: job.terminal_id })
    } catch (error) {
      // Already closed by hand: the goal is reached. Anything else is a real failure.
      if (errorCode(error) !== 'action_failed') return mapHostError(error)
    }
    this.close(job, 'stopped')
    this.emitStatus(job, 'stopped', excerpt)
    await this.d.store.saveJobs(linkId)
    this.d.changed()
    return { ok: true, data: { stopped: true } }
  }

  // ---- events from Orca ----------------------------------------------------------------------

  private close(job: JobRecord, phase: 'stopped' | 'gone'): void {
    job.phase = phase
    job.updated_at = this.d.now()
    const t = this.timers.get(job.job_id)
    if (t) clearTimeout(t)
    this.timers.delete(job.job_id)
    if (job.terminal_id) this.byTerminal.delete(job.terminal_id)
    this.d.store.pruneJobs(job.link_id)
  }

  private emitStatus(job: JobRecord, state: JobState, excerpt?: string, options: ScreenOption[] = []): void {
    job.last_emitted = state
    job.last_hash = excerptHash(state, job.orca_state, excerpt, options)
    const event: JobEvent = {
      kind: 'job.status',
      job_id: job.job_id,
      state,
      orca_state: (job.orca_state ?? 'done') as OrcaState,
      at: this.d.now()
    }
    if (job.outcome) event.outcome = job.outcome
    if (excerpt && EXCERPT_STATES.has(state)) event.excerpt = excerpt
    if (state === 'waiting_user' && options.length) event.options = options
    this.log('job.status', { link_id: job.link_id, job_id: job.job_id, state })
    this.d.publish(job.link_id, event)
  }

  onAgentStatus(payload: AgentStatusPayload): void {
    const ref = payload.terminalId ? this.byTerminal.get(payload.terminalId) : undefined
    if (!ref) return // not one of ours: agents opened by hand are never exposed
    const job = this.d.store.jobsOf(ref.linkId)[ref.jobId]
    if (!job || job.phase !== 'running') return
    if (typeof payload.state !== 'string' || !ORCA_STATES.has(payload.state)) return
    if (payload.sessionId) job.session_id = payload.sessionId
    const outcome = payload.state === 'done' ? (payload.mainAgent?.outcome ?? null) : null
    this.observe(job, payload.state as OrcaState, outcome)
  }

  private observe(job: JobRecord, orca: OrcaState, outcome: string | null): void {
    job.orca_state = orca
    job.outcome = outcome
    job.updated_at = this.d.now()
    const previous = this.timers.get(job.job_id)
    if (previous) clearTimeout(previous)
    this.timers.set(
      job.job_id,
      setTimeout(() => void this.settle(job.link_id, job.job_id), this.d.timing.stabilizeMs)
    )
    void this.d.store.saveJobs(job.link_id)
  }

  private async settle(linkId: string, jobId: string): Promise<void> {
    this.timers.delete(jobId)
    const job = this.d.store.jobsOf(linkId)[jobId]
    if (!job || job.phase !== 'running' || !job.orca_state) return
    const state = mapState(job.orca_state, job.outcome ?? undefined)
    const screen = EXCERPT_STATES.has(state) ? await this.readScreen(job) : undefined
    const excerpt = screen?.excerpt
    const options = state === 'waiting_user' ? (screen?.options ?? []) : []
    // The state may have moved while the terminal was read.
    if (job.phase !== 'running' || this.timers.has(jobId)) return
    if (mapState(job.orca_state ?? 'done', job.outcome ?? undefined) !== state) return
    // Dedupe by (state, Orca state, normalized excerpt): a new question is a new event; the same
    // screen with other timers or spinner frames is not. A state change is always reported, so the
    // skill's view of the job never goes stale.
    if (state === job.last_emitted && excerptHash(state, job.orca_state, excerpt, options) === job.last_hash) return
    this.emitStatus(job, state, excerpt, options)
    await this.d.store.saveJobs(linkId)
    this.d.changed()
  }

  onWorkspaceRemoved(payload: { workspaceId?: string; workspaceListId?: string }): void {
    for (const link of this.d.store.links) {
      for (const job of Object.values(this.d.store.jobsOf(link.link_id))) {
        if (job.phase !== 'running' || !job.workspace_id) continue
        if (job.workspace_id === payload.workspaceListId || job.workspace_id === payload.workspaceId) {
          this.markGone(job, 'workspace_removed')
        }
      }
    }
  }

  private markGone(job: JobRecord, reason: string): void {
    this.close(job, 'gone')
    this.log('job.gone', { link_id: job.link_id, job_id: job.job_id, reason })
    this.d.publish(job.link_id, { kind: 'job.gone', job_id: job.job_id, reason })
    void this.d.store.saveJobs(job.link_id)
    this.d.changed()
  }

  /** Catches what happened while the worker was down or an event was missed. */
  async reconcile(): Promise<void> {
    for (const link of [...this.d.store.links]) {
      for (const job of Object.values(this.d.store.jobsOf(link.link_id))) {
        if (job.phase !== 'running' || !job.workspace_id || !job.terminal_id) continue
        if (this.d.now() - job.created_at < this.d.timing.graceMs) continue
        try {
          const { terminals } = (await this.d.host.call(M.terminalList, { workspaceId: job.workspace_id })) as {
            terminals: { id: string }[]
          }
          if (!terminals.some((t) => t.id === job.terminal_id)) {
            this.markGone(job, 'terminal_closed')
            continue
          }
        } catch (error) {
          if (errorCode(error) === 'action_failed') this.markGone(job, 'workspace_missing')
          continue
        }
        const orca = await this.currentOrcaState(job)
        if (orca && job.phase === 'running') {
          const outcome = orca === 'done' ? job.outcome : null
          if (mapState(orca, outcome ?? undefined) !== job.last_emitted && !this.timers.has(job.job_id)) {
            this.observe(job, orca, outcome)
          }
        }
      }
    }
  }
}

function startData(job: JobRecord): Record<string, unknown> {
  const data: Record<string, unknown> = { workspace_id: job.workspace_id, terminal_id: job.terminal_id }
  if (job.session_id) data.session_id = job.session_id
  return data
}

/** Identity of a report: state, Orca's own state (a permission is not a question), the excerpt and the options. */
function excerptHash(state: string, orca: string | null, excerpt: string | undefined, options: ScreenOption[] = []): string {
  return createHash('sha256').update(`${state}\n${orca ?? ''}\n${EXCERPT_STATES.has(state as JobState) ? normalizeExcerpt(excerpt ?? '') : ''}\n${options.map((o) => `${o.n}:${o.label}`).join('|')}`).digest('hex').slice(0, 16)
}
