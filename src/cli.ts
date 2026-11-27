// The Orca CLI, used only for `send`: the plugin API's terminal.sendText cannot reach terminals
// outside the active worktree. Always execFile (no shell), never with ELECTRON_RUN_AS_NODE.
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

export const CLI_TIMEOUT_MS = 30_000
/** Deleting a worktree can take a while (a big checkout); the skill waits 120 s for `remove_workspace`. */
export const WORKTREE_RM_TIMEOUT_MS = 100_000
// eslint-disable-next-line no-control-regex
const WORKTREE_SELECTOR = /^(identity|id):[^\u0000-\u001f\u007f]{1,2000}$/
// eslint-disable-next-line no-control-regex
const WORKTREE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}::[^\u0000-\u001f\u007f]{1,2000}$/

export interface ExecResult {
  stdout: string
  stderr: string
}
export type ExecFn = (file: string, args: string[], timeoutMs: number) => Promise<ExecResult>

export interface WorktreeInfo {
  /** Orca's exact id (`<repo-id>::<path>`), the only thing `worktree rm` is given. */
  id: string
  identityKey: string
  isMain: boolean
  /** `refs/heads/<name>` or null (detached). */
  branch: string | null
}

export interface CliInfo {
  path: string
  orcaVersion: string | null
}

/**
 * Variables of the plugin host that must not reach the Orca CLI. The host is a Node child process with an IPC
 * channel: `NODE_CHANNEL_FD` makes the CLI (Electron/Node) try to open that channel and abort (SIGABRT), so the CLI
 * looks missing and `hello` announces no `send.cli`/`send.working`. `ELECTRON_RUN_AS_NODE` would run it as plain Node.
 */
const HOST_ONLY_ENV = ['ELECTRON_RUN_AS_NODE', 'NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE', 'CRASHDUMP_SIGNAL_FD', 'CRASHPAD_HANDLER_PID']

/** The environment the Orca CLI runs with: the plugin host's, without what belongs to the host process. */
export function cliEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env }
  for (const key of HOST_ONLY_ENV) delete out[key]
  return out
}

export const defaultExec: ExecFn = (file, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    const env = cliEnv()
    execFile(
      file,
      args,
      { timeout: timeoutMs, env, maxBuffer: 1024 * 1024, windowsHide: true, shell: false },
      (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stdout, stderr }))
        else resolve({ stdout, stderr })
      }
    )
  })

/** Candidate CLI paths, in the order of the contract (section 6). */
export function candidatePaths(configured: string | undefined, platform = process.platform): string[] {
  const out: string[] = []
  if (configured && isAbsolute(configured)) out.push(configured)
  // Only Linux is validated; macOS and Windows locations are pending.
  if (platform === 'linux') out.push(join(homedir(), '.config', 'orca', 'linux-orca-cli-shim', 'orca'))
  out.push('orca')
  return out
}

/** `<path> status --json` must answer ok:true with a runtime: a screen reader named orca will not. */
export function parseStatus(stdout: string): { ok: boolean; orcaVersion: string | null } {
  try {
    const parsed = JSON.parse(stdout) as { ok?: unknown; result?: { runtime?: { appVersion?: unknown } } }
    const runtime = parsed?.result?.runtime
    if (parsed?.ok !== true || !runtime || typeof runtime !== 'object') return { ok: false, orcaVersion: null }
    const version = runtime.appVersion
    return { ok: true, orcaVersion: typeof version === 'string' ? version.slice(0, 40) : null }
  } catch {
    return { ok: false, orcaVersion: null }
  }
}

export class OrcaCli {
  private cached: CliInfo | null = null
  private checkedAt = 0

  private configuredPath: () => Promise<string | undefined>
  private exec: ExecFn
  private now: () => number
  private platform: string

  constructor(
    configuredPath: () => Promise<string | undefined>,
    exec: ExecFn = defaultExec,
    now: () => number = Date.now,
    platform: string = process.platform
  ) {
    this.configuredPath = configuredPath
    this.exec = exec
    this.now = now
    this.platform = platform
  }

  /** The first candidate that passes the status probe; cached for a minute. */
  async resolve(force = false): Promise<CliInfo | null> {
    if (!force && this.now() - this.checkedAt < 60_000) return this.cached
    this.checkedAt = this.now()
    this.cached = null
    for (const path of candidatePaths(await this.configuredPath(), this.platform as NodeJS.Platform)) {
      try {
        const { stdout } = await this.exec(path, ['status', '--json'], CLI_TIMEOUT_MS)
        const status = parseStatus(stdout)
        if (status.ok) {
          this.cached = { path, orcaVersion: status.orcaVersion }
          break
        }
      } catch {
        /* try the next one */
      }
    }
    return this.cached
  }

  /** `orca terminal show`: what the runtime knows about a terminal. Throws `cli_unavailable` or `internal`. */
  async show(terminalId: string): Promise<{ agentIdentity: string | null; connected: boolean; writable: boolean }> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(terminalId)) throw cliError('internal', 'bad terminal id')
    let info = await this.resolve()
    if (!info) info = await this.resolve(true)
    if (!info) throw cliError('cli_unavailable', 'the Orca CLI was not found')
    try {
      const { stdout } = await this.exec(info.path, ['terminal', 'show', '--terminal', terminalId, '--json'], CLI_TIMEOUT_MS)
      const t = (JSON.parse(stdout) as { ok?: unknown; result?: { terminal?: Record<string, unknown> } }).result?.terminal
      if (!t) throw new Error('no terminal')
      return {
        agentIdentity: typeof t.agentIdentity === 'string' ? t.agentIdentity : null,
        connected: t.connected === true,
        writable: t.writable === true
      }
    } catch (error) {
      const e = error as { stdout?: unknown; stderr?: unknown; code?: string }
      if (e.code === 'internal' && e.stdout === undefined) throw cliError('internal', 'could not read the terminal from the Orca CLI')
      throw cliFailure(cliCodeOf(e.stdout, e.stderr))
    }
  }

  /**
   * `orca terminal close --terminal <id>`: the fallback of `stop` for a terminal the plugin API refuses to
   * close (one this plugin no longer owns, for example after an update or a reinstall). Same error
   * mapping as `send`; a terminal that no longer exists is not an error for the caller to decide here:
   * it throws `not_found`.
   */
  async close(terminalId: string): Promise<void> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(terminalId)) throw cliError('internal', 'bad terminal id')
    let info = await this.resolve()
    if (!info) info = await this.resolve(true)
    if (!info) throw cliError('cli_unavailable', 'the Orca CLI was not found')
    let out: ExecResult
    try {
      out = await this.exec(info.path, ['terminal', 'close', '--terminal', terminalId, '--json'], CLI_TIMEOUT_MS)
    } catch (error) {
      const e = error as { killed?: boolean; signal?: string; stdout?: unknown; stderr?: unknown }
      if (e.killed || e.signal === 'SIGTERM') throw cliError('timeout', 'the Orca CLI timed out')
      const code = cliCodeOf(e.stdout, e.stderr)
      if (!code) this.checkedAt = 0
      throw cliFailure(code)
    }
    try {
      if ((JSON.parse(out.stdout) as { ok?: unknown }).ok === false) throw cliFailure(cliCodeOf(out.stdout, out.stderr))
    } catch (error) {
      if (error instanceof SyntaxError) return // not JSON: exit status 0 is enough
      throw error
    }
  }

  /**
   * `orca worktree show --worktree <selector> --json`: the one worktree Orca resolves for an exact selector.
   * Throws `not_found` when Orca knows no such worktree (`selector_not_found`), else the usual mapped errors.
   */
  async worktreeShow(selector: string): Promise<WorktreeInfo> {
    if (!WORKTREE_SELECTOR.test(selector)) throw cliError('internal', 'bad worktree selector')
    const parsed = await this.runJson(['worktree', 'show', '--worktree', selector, '--json'], CLI_TIMEOUT_MS)
    const w = (parsed as { result?: { worktree?: Record<string, unknown> } }).result?.worktree
    const identity = w?.identity as { key?: unknown } | undefined
    if (!w || typeof w.id !== 'string' || typeof identity?.key !== 'string') {
      throw cliError('failed', 'Orca returned an unexpected answer for the worktree')
    }
    return {
      id: w.id,
      identityKey: identity.key,
      isMain: w.isMainWorktree !== false, // anything but an explicit "not main" is treated as main
      branch: typeof w.branch === 'string' ? w.branch : null
    }
  }

  /**
   * `orca worktree rm --worktree id:<exact id> --delete-branch [--force] --json`. Semantics of Orca 1.4.277:
   * without `--force` it refuses a worktree with uncommitted changes (a `runtime_error` that lists the
   * files: normalised to `has_changes`, without the file names), and `--delete-branch` keeps a branch
   * Orca cannot prove integrated and says so with `preservedBranch`. `not_found` when the worktree is gone.
   */
  async worktreeRemove(worktreeId: string, force: boolean): Promise<{ preservedBranch: string | null }> {
    if (!WORKTREE_ID.test(worktreeId)) throw cliError('internal', 'bad worktree id')
    const args = ['worktree', 'rm', '--worktree', `id:${worktreeId}`, '--delete-branch']
    if (force) args.push('--force')
    args.push('--json')
    const parsed = (await this.runJson(args, WORKTREE_RM_TIMEOUT_MS)) as { result?: { preservedBranch?: { branchName?: unknown } } }
    const kept = parsed.result?.preservedBranch
    if (kept && typeof kept === 'object') {
      return { preservedBranch: typeof kept.branchName === 'string' && kept.branchName ? kept.branchName : '' }
    }
    return { preservedBranch: null }
  }

  /** Runs the CLI (resolved path, no shell) and returns its JSON answer; failures become errors of the contract. */
  private async runJson(args: string[], timeoutMs: number): Promise<object> {
    let info = await this.resolve()
    if (!info) info = await this.resolve(true)
    if (!info) throw cliError('cli_unavailable', 'the Orca CLI was not found')
    let out: ExecResult
    try {
      out = await this.exec(info.path, args, timeoutMs)
    } catch (error) {
      const e = error as { killed?: boolean; signal?: string; stdout?: unknown; stderr?: unknown }
      if (e.killed || e.signal === 'SIGTERM') throw cliError('timeout', 'the Orca CLI timed out')
      const code = cliCodeOf(e.stdout, e.stderr)
      if (!code) this.checkedAt = 0
      throw worktreeFailure(code, cliMessageOf(e.stdout))
    }
    let parsed: { ok?: unknown } | null = null
    try {
      parsed = JSON.parse(out.stdout) as { ok?: unknown }
    } catch {
      throw cliError('failed', 'the Orca CLI answered something that is not JSON')
    }
    if (!parsed || typeof parsed !== 'object') throw cliError('failed', 'the Orca CLI answered something unexpected')
    if (parsed.ok === false) throw worktreeFailure(cliCodeOf(out.stdout, out.stderr), cliMessageOf(out.stdout))
    return parsed
  }

  /**
   * `orca terminal send`: `text` (optionally followed by Enter). Throws an error whose `code` is already
   * a code of the contract (`cli_unavailable`, `timeout`, `needs_option`, `forbidden`...) and whose
   * `cliCode` is the CLI's own, for logs.
   */
  async send(terminalId: string, text: string, enter: boolean): Promise<void> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(terminalId)) throw cliError('internal', 'bad terminal id')
    let info = await this.resolve()
    if (!info) info = await this.resolve(true)
    if (!info) throw cliError('cli_unavailable', 'the Orca CLI was not found')
    // `--text=<value>` keeps a text that starts with "-" from being read as an option.
    const args = ['terminal', 'send', '--terminal', terminalId, `--text=${text}`]
    if (enter) args.push('--enter')
    args.push('--json')
    let out: ExecResult
    try {
      out = await this.exec(info.path, args, CLI_TIMEOUT_MS)
    } catch (error) {
      const e = error as { killed?: boolean; signal?: string; stdout?: unknown; stderr?: unknown }
      if (e.killed || e.signal === 'SIGTERM') throw cliError('timeout', 'the Orca CLI timed out')
      const code = cliCodeOf(e.stdout, e.stderr)
      if (!code) this.checkedAt = 0 // a failure with no code may mean the CLI itself is gone: probe it again
      throw cliFailure(code)
    }
    let parsed: { ok?: unknown } | null = null
    try {
      parsed = JSON.parse(out.stdout) as { ok?: unknown }
    } catch {
      /* not JSON: exit status 0 is enough */
    }
    if (parsed?.ok === false) throw cliFailure(cliCodeOf(out.stdout, out.stderr))
  }
}

/** The CLI's error code from its JSON (`{ok:false,error:{code}}` or `{code}`), else a known token in its text. */
export function cliCodeOf(...outputs: unknown[]): string | null {
  for (const raw of outputs) {
    if (typeof raw !== 'string' || raw === '') continue
    const text = raw.slice(0, 20_000)
    try {
      const v = JSON.parse(text) as { code?: unknown; error?: { code?: unknown } | string }
      const code = typeof v.error === 'object' && v.error ? v.error.code : (v.code ?? (typeof v.error === 'string' ? v.error : undefined))
      if (typeof code === 'string' && /^[A-Za-z0-9_.:-]{1,60}$/.test(code)) return code.toLowerCase()
    } catch {
      /* plain text */
    }
    const known = /\b(agent_prompt_blocked|terminal_not_found|not_writable|runtime_unavailable|invalid_argument|timeout)\b/.exec(text)
    if (known) return known[1]!
  }
  return null
}

/** Maps a CLI error code to an error of the contract with a message the user can act on. */
export function cliFailure(cliCode: string | null): Error {
  const done = (code: string, message: string) => Object.assign(cliError(code, message), { cliCode: cliCode ?? undefined })
  if (!cliCode) return done('internal', 'the Orca CLI failed without an error code')
  if (cliCode === 'agent_prompt_blocked') {
    return done('needs_option', 'the agent shows a selector: answer with the number of an option')
  }
  if (/not_found|no_such|unknown_terminal/.test(cliCode)) return done('not_found', 'the terminal no longer exists in Orca')
  if (/timeout/.test(cliCode)) return done('timeout', 'the Orca CLI timed out')
  if (/invalid|bad_|usage|missing/.test(cliCode)) return done('invalid_args', `the Orca CLI rejected the request (${cliCode})`)
  if (/not_writable|read_only|readonly|forbidden|permission|denied|blocked|trust|not_agent/.test(cliCode)) {
    return done('forbidden', `Orca does not allow writing to this terminal now (${cliCode})`)
  }
  if (/unavailable|not_running|runtime|connection|econn/.test(cliCode)) {
    return done('orca_unavailable', `Orca is not available (${cliCode})`)
  }
  return done('internal', `the Orca CLI refused the request with an unknown code (${cliCode})`)
}

function cliError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/** The CLI's `error.message` from its JSON, bounded and without control characters. */
export function cliMessageOf(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  try {
    const v = JSON.parse(raw.slice(0, 20_000)) as { error?: { message?: unknown } }
    // eslint-disable-next-line no-control-regex
    return typeof v.error?.message === 'string' ? v.error.message.slice(0, 4000).replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ') : ''
  } catch {
    return ''
  }
}

// What `orca worktree rm` says when git refuses for uncommitted changes: the porcelain status lines.
const DIRTY = /^Failed to delete worktree at [\s\S]*?\. ([ MADRCUT?!]{1,2} \S[^\n]*(?:\n[ MADRCUT?!]{2} \S[^\n]*)*)\s*$/

/** Local paths and file names stay on this computer: an absolute path in a CLI message becomes `<path>`. */
const scrub = (text: string, max: number): string =>
  text.replace(/(?:[A-Za-z]:\\|\/)[^\s'"]+/g, '<path>').replace(/\s+/g, ' ').trim().slice(0, max)

/** Error mapping of the worktree commands: never a mute `internal`. */
export function worktreeFailure(cliCode: string | null, message: string): Error {
  const done = (code: string, text: string) => Object.assign(cliError(code, text), { cliCode: cliCode ?? undefined })
  if (cliCode === 'selector_not_found') return done('not_found', 'the worktree no longer exists in Orca')
  if (cliCode === 'runtime_error') {
    const dirty = DIRTY.exec(message)
    if (dirty) {
      const files = dirty[1]!.split('\n').length
      return done('has_changes', `the worktree has uncommitted changes (${files} file${files === 1 ? '' : 's'})`)
    }
    return done('failed', `Orca could not remove the worktree: ${scrub(message, 300) || 'no details'}`)
  }
  const mapped = cliFailure(cliCode) as Error & { code?: string }
  if (mapped.code === 'internal' && cliCode) {
    return done('failed', `Orca refused the request (${cliCode})${message ? `: ${scrub(message, 200)}` : ''}`)
  }
  return mapped
}
