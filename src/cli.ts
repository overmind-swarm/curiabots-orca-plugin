// The Orca CLI, used only for `send`: the plugin API's terminal.sendText cannot reach terminals
// outside the active worktree. Always execFile (no shell), never with ELECTRON_RUN_AS_NODE.
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

export const CLI_TIMEOUT_MS = 30_000

export interface ExecResult {
  stdout: string
  stderr: string
}
export type ExecFn = (file: string, args: string[], timeoutMs: number) => Promise<ExecResult>

export interface CliInfo {
  path: string
  orcaVersion: string | null
}

export const defaultExec: ExecFn = (file, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
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
    } catch {
      throw cliError('internal', 'could not read the terminal from the Orca CLI')
    }
  }

  /** `orca terminal send`. Throws `cli_unavailable` or `timeout` / `internal`. */
  async send(terminalId: string, text: string, enter: boolean): Promise<void> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(terminalId)) throw cliError('internal', 'bad terminal id')
    let info = await this.resolve()
    if (!info) info = await this.resolve(true)
    if (!info) throw cliError('cli_unavailable', 'the Orca CLI was not found')
    // `--text=<value>` keeps a text that starts with "-" from being read as an option.
    const args = ['terminal', 'send', '--terminal', terminalId, `--text=${text}`]
    if (enter) args.push('--enter')
    args.push('--json')
    try {
      const { stdout } = await this.exec(info.path, args, CLI_TIMEOUT_MS)
      try {
        const parsed = JSON.parse(stdout) as { ok?: unknown }
        if (parsed.ok === false) throw cliError('internal', 'the CLI refused the text')
      } catch (error) {
        if ((error as { code?: string }).code) throw error
      }
    } catch (error) {
      const e = error as { code?: string; killed?: boolean; signal?: string }
      if (e.code === 'internal' || e.code === 'cli_unavailable') throw error
      this.checkedAt = 0
      if (e.killed || e.signal === 'SIGTERM') throw cliError('timeout', 'the Orca CLI timed out')
      throw cliError('internal', 'the Orca CLI failed')
    }
  }
}

function cliError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}
