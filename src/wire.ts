// Wire format of the skill <-> plugin contract (v1). Everything that comes from the server is
// untrusted: it is parsed and validated here before any other module sees it.
import { byteLength } from './util.ts'

export const PROTOCOL_VERSION = 1
export const MAX_MESSAGE_BYTES = 256 * 1024
export const MAX_PROMPT_BYTES = 16 * 1024
export const MAX_SEND_BYTES = 16 * 1024
export const MAX_TAIL_LINES = 400

export type ErrorCode =
  | 'forbidden'
  | 'not_found'
  | 'invalid_args'
  | 'limit_reached'
  | 'in_progress'
  | 'failed'
  | 'orca_unavailable'
  | 'cli_unavailable'
  | 'timeout'
  | 'needs_option'
  | 'has_changes'
  | 'agent_unavailable'
  | 'internal'

export type JobState =
  | 'starting'
  | 'working'
  | 'waiting_user'
  | 'idle'
  | 'failed'
  | 'stopped'
  | 'unknown'

export type OrcaState = 'working' | 'blocked' | 'waiting' | 'done'

export interface ProjectRef {
  id: string
  name: string
  host_id: string
}

export type JobEvent =
  | {
      kind: 'job.status'
      job_id: string
      state: JobState
      orca_state: OrcaState
      outcome?: string
      excerpt?: string
      /** Numbered choices of the selector the agent shows (waiting_user only). */
      options?: { n: number; label: string }[]
      at: number
    }
  | { kind: 'job.gone'; job_id: string; reason: string }

export interface Limits {
  /** The user's cap of simultaneous jobs of this link, from the skill. `0` is no limit; absent means the skill said nothing. */
  max_jobs?: number
  max_prompt_bytes?: number
}

export type CommandName = 'start_job' | 'get_job' | 'read_output' | 'send' | 'stop' | 'remove_workspace'

export interface StartJobArgs {
  job_id: string
  project_id: string
  host_id?: string
  workspace_name: string
  base_branch?: string
  agent: string
  model?: string
  prompt: string
}
export interface JobArgs {
  job_id: string
}
export interface ReadOutputArgs {
  job_id: string
  tail_lines: number
}
/** Exactly one of `text` (with `enter`) or `option` (a digit 1..9, sent alone, no Enter). */
export interface SendArgs {
  job_id: string
  text?: string
  enter?: boolean
  option?: number
}
/** Deletes the worktree the job created. `force` discards uncommitted changes. Only `job_id` selects what is removed. */
export interface RemoveWorkspaceArgs {
  job_id: string
  force: boolean
}
export interface CommandArgsMap {
  start_job: StartJobArgs
  get_job: JobArgs
  read_output: ReadOutputArgs
  send: SendArgs
  stop: JobArgs
  remove_workspace: RemoveWorkspaceArgs
}

export type ServerMessage =
  | {
      type: 'welcome'
      link_id: string
      /** Absent when the server does not send it: the plugin then keeps the label it already has. */
      bot_label?: string
      /** Optional name the user gave the link in CuriaBots. */
      link_name?: string
      limits: Limits
    }
  /** The user changed the cap while the plugin was connected: it replaces the one in `welcome`. */
  | { type: 'limits'; limits: Limits }
  /** The jobs of this link the skill has archived: they no longer occupy a slot. Always the complete set. */
  | { type: 'archived'; job_ids: string[] }
  | { type: 'command'; id: string; name: string; args: unknown }
  | { type: 'ack'; seq: number }
  | { type: 'revoked'; reason: string }
  | { type: 'ping' }

export const LINK_ID = /^[A-Za-z0-9_-]{1,64}$/
export const JOB_ID = /^[A-Za-z0-9_-]{8,64}$/
const COMMAND_ID = /^[A-Za-z0-9_-]{1,64}$/
const AGENT = /^[a-z0-9][a-z0-9-]{0,31}$/
const BRANCH = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,199}$/
// eslint-disable-next-line no-control-regex
const HAS_CONTROL = /[\u0000-\u001f\u007f]/

export type Checked<T> = { ok: true; value: T } | { ok: false; message: string }
const bad = (message: string): { ok: false; message: string } => ({ ok: false, message })

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cleanLabel(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  // eslint-disable-next-line no-control-regex
  const label = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80)
  return label || fallback
}

function posInt(value: unknown, max: number): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? Math.min(value, max) : undefined
}

/** Most jobs a cap can ask for; `0` (no limit) is the way to ask for more. */
const MAX_JOBS_CAP = 1000
/** Most archived ids one `archived` message can carry. */
const MAX_ARCHIVED_IDS = 500

/** The `limits` object of `welcome` and of the `limits` message. `max_jobs: 0` is kept: it means no limit. */
function parseLimits(raw: unknown): Limits {
  const limits: Limits = {}
  if (!isObject(raw)) return limits
  const max = raw.max_jobs
  if (typeof max === 'number' && Number.isInteger(max) && max >= 0) limits.max_jobs = Math.min(max, MAX_JOBS_CAP)
  const maxPrompt = posInt(raw.max_prompt_bytes, MAX_PROMPT_BYTES)
  if (maxPrompt) limits.max_prompt_bytes = maxPrompt
  return limits
}

/** Parses one text frame from the skill; null means "ignore it". */
export function parseServerMessage(raw: unknown): ServerMessage | null {
  if (typeof raw !== 'string' || byteLength(raw) > MAX_MESSAGE_BYTES) return null
  let msg: unknown
  try {
    msg = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isObject(msg) || msg.v !== PROTOCOL_VERSION || typeof msg.type !== 'string') return null
  switch (msg.type) {
    case 'welcome': {
      if (typeof msg.link_id !== 'string' || !LINK_ID.test(msg.link_id)) return null
      const limits = parseLimits(msg.limits)
      const botLabel = cleanLabel(msg.bot_label, '')
      const linkName = cleanLabel(msg.link_name, '')
      return {
        type: 'welcome',
        link_id: msg.link_id,
        ...(botLabel ? { bot_label: botLabel } : {}),
        ...(linkName ? { link_name: linkName } : {}),
        limits
      }
    }
    case 'limits':
      return { type: 'limits', limits: parseLimits(msg.limits) }
    case 'archived': {
      if (!Array.isArray(msg.job_ids)) return null
      const ids = msg.job_ids.filter((id): id is string => typeof id === 'string' && JOB_ID.test(id) && !RESERVED_KEYS.has(id)).slice(0, MAX_ARCHIVED_IDS)
      return { type: 'archived', job_ids: ids }
    }
    case 'command':
      if (typeof msg.id !== 'string' || !COMMAND_ID.test(msg.id) || typeof msg.name !== 'string') return null
      return { type: 'command', id: msg.id, name: msg.name.slice(0, 40), args: msg.args }
    case 'ack':
      return typeof msg.seq === 'number' && Number.isSafeInteger(msg.seq) ? { type: 'ack', seq: msg.seq } : null
    case 'revoked':
      return { type: 'revoked', reason: cleanLabel(msg.reason, 'revoked') }
    case 'ping':
      return { type: 'ping' }
    default:
      return null
  }
}

const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString', 'valueOf'])

function jobId(value: unknown): Checked<string> {
  // The id is used as an object key: names that exist on every object are refused.
  return typeof value === 'string' && JOB_ID.test(value) && !RESERVED_KEYS.has(value)
    ? { ok: true, value }
    : bad('invalid job_id')
}

function optionalString(
  value: unknown,
  name: string,
  max: number,
  pattern?: RegExp
): Checked<string | undefined> {
  if (value === undefined || value === null) return { ok: true, value: undefined }
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return bad(`invalid ${name}`)
  if (HAS_CONTROL.test(value) || (pattern && !pattern.test(value))) return bad(`invalid ${name}`)
  return { ok: true, value }
}

export function validateArgs<N extends CommandName>(
  name: N,
  args: unknown,
  maxPromptBytes: number = MAX_PROMPT_BYTES
): Checked<CommandArgsMap[N]> {
  const result = validateAny(name, args, maxPromptBytes)
  return result as Checked<CommandArgsMap[N]>
}

function validateAny(name: CommandName, args: unknown, maxPromptBytes: number): Checked<unknown> {
  if (!isObject(args)) return bad('args must be an object')
  const id = jobId(args.job_id)
  if (!id.ok) return id
  switch (name) {
    case 'get_job':
    case 'stop':
      return { ok: true, value: { job_id: id.value } }
    case 'remove_workspace': {
      if (args.force !== undefined && args.force !== null && typeof args.force !== 'boolean') return bad('invalid force')
      return { ok: true, value: { job_id: id.value, force: args.force === true } }
    }
    case 'read_output': {
      const n = args.tail_lines
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) return bad('invalid tail_lines')
      return { ok: true, value: { job_id: id.value, tail_lines: Math.min(n, MAX_TAIL_LINES) } }
    }
    case 'send': {
      if (args.option !== undefined && args.option !== null) {
        if (args.text !== undefined && args.text !== null) return bad('send takes text or option, not both')
        const o = args.option
        if (typeof o !== 'number' || !Number.isInteger(o) || o < 1 || o > 9) return bad('invalid option')
        if (args.enter !== undefined && args.enter !== false) return bad('option is sent without enter')
        return { ok: true, value: { job_id: id.value, option: o } }
      }
      if (typeof args.text !== 'string' || args.text.length === 0) return bad('invalid text')
      if (byteLength(args.text) > MAX_SEND_BYTES || args.text.includes('\u0000')) return bad('invalid text')
      if (typeof args.enter !== 'boolean') return bad('invalid enter')
      return { ok: true, value: { job_id: id.value, text: args.text, enter: args.enter } }
    }
    case 'start_job': {
      const project = optionalString(args.project_id, 'project_id', 200)
      if (!project.ok || !project.value) return bad('invalid project_id')
      const host = optionalString(args.host_id, 'host_id', 200)
      if (!host.ok) return host
      const wsName = optionalString(args.workspace_name, 'workspace_name', 80)
      if (!wsName.ok || !wsName.value) return bad('invalid workspace_name')
      const base = optionalString(args.base_branch, 'base_branch', 200, BRANCH)
      if (!base.ok) return base
      if (base.value && (base.value.includes('..') || base.value.endsWith('/') || base.value.endsWith('.lock')))
        return bad('invalid base_branch')
      const agent = optionalString(args.agent, 'agent', 32, AGENT)
      if (!agent.ok || !agent.value) return bad('invalid agent')
      const model = optionalString(args.model, 'model', 100)
      if (!model.ok) return model
      if (typeof args.prompt !== 'string' || args.prompt.trim() === '') return bad('invalid prompt')
      if (byteLength(args.prompt) > maxPromptBytes) return bad('prompt too large')
      if (args.prompt.includes('\u0000')) return bad('invalid prompt')
      return {
        ok: true,
        value: {
          job_id: id.value,
          project_id: project.value,
          host_id: host.value,
          workspace_name: wsName.value,
          base_branch: base.value,
          agent: agent.value,
          model: model.value,
          prompt: args.prompt
        }
      }
    }
    default:
      return bad('unknown command')
  }
}

export const COMMAND_NAMES: readonly CommandName[] = ['start_job', 'get_job', 'read_output', 'send', 'stop', 'remove_workspace']
export function isCommandName(name: string): name is CommandName {
  return (COMMAND_NAMES as readonly string[]).includes(name)
}

/** Maps Orca's agent state (and the outcome of a finished turn) to the job state of the contract. */
export function mapState(orca: OrcaState, outcome?: string): JobState {
  switch (orca) {
    case 'working':
      return 'working'
    case 'waiting':
    case 'blocked':
      return 'waiting_user'
    case 'done':
      return outcome === 'failure' ? 'failed' : 'idle'
    default:
      return 'unknown'
  }
}
