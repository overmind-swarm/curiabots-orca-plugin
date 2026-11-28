// `add_project` (dev#2424): clone a Git repository into the clone folder the user chose on this computer and register
// it in Orca with `orca repo add`. Everything that decides where something is written lives here, on this computer:
// the service only sends a URL and, optionally, the name of one folder inside that root.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { lstat, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, sep } from 'node:path'
import { cliEnv } from './cli.ts'
import type { ExecResult } from './cli.ts'

/** Most a clone may take: the skill waits 120 s for the whole command, and `orca repo add` gets 30 s of it. */
export const CLONE_TIMEOUT_MS = 80_000
export const MAX_URL_LENGTH = 500
/** One folder name inside the clone root: no separators, no leading dot (`.`, `..`, hidden), nothing a shell or git reads as an option. */
export const DIRECTORY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
/** Prefix of the temporary folder a clone lands in before it is renamed to its final name. */
const TEMP_PREFIX = '.curiabots-clone-'

// eslint-disable-next-line no-control-regex
const CONTROL_OR_SPACE = /[\u0000- \u007f]/
const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252})$/
const SCP_LIKE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,63})@([A-Za-z0-9][A-Za-z0-9.-]{0,252}):([A-Za-z0-9._~/-]{1,400})$/
const PATH_CHARS = /^[A-Za-z0-9._~/%-]+$/

export type GitUrl = { kind: 'https' | 'ssh'; url: string; repoName: string }

/**
 * Hosts a clone must never reach: this computer, its private network and link-local addresses (a cloud metadata
 * service), named or as literals, plus names that only mean something on a local network. Without this, a confirmed
 * request could make the user's computer probe its own LAN. Names are not resolved: a public name that points to a
 * private address is not caught here.
 */
export function isLocalHost(rawHost: string): boolean {
  // Every form goes through the WHATWG host parser first, as https URLs already do: `0x7f.0.0.1`, `0177.1` or
  // `2130706433` become `127.0.0.1`, and IPv6 is compressed. ssh would otherwise resolve those itself (inet_aton).
  let host: string
  try {
    host = new URL(`https://${rawHost.includes(':') && !rawHost.startsWith('[') ? `[${rawHost}]` : rawHost}/`).hostname.toLowerCase()
  } catch {
    return true
  }
  host = host.replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (host.includes(':')) {
    // IPv6: loopback, unspecified, IPv4-compatible and -mapped (`::…`), unique local (fc00::/7), link-local
    // (fe80::/10), NAT64 (64:ff9b::/96) and multicast.
    return host.startsWith('::') || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith('64:ff9b:') || host.startsWith('ff')
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return (
      a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) || a >= 224
    )
  }
  // Anything still all numeric labels (in any base) is an address in disguise: refused.
  if (host.split('.').every((label) => /^(0x[0-9a-f]*|[0-9]+)$/i.test(label))) return true
  if (!host.includes('.')) return true // single-label names: intranet, localhost
  return /(^|\.)(localhost|local|internal|lan|home\.arpa|intranet|corp)$/.test(host)
}

/** The last path segment without `.git`, or '' when it is not usable as a folder name. */
function repoNameOf(path: string): string {
  const last = path.replace(/\/+$/, '').split('/').pop() ?? ''
  const name = last.replace(/\.git$/i, '')
  return DIRECTORY.test(name) && !name.endsWith('.lock') ? name : ''
}

/**
 * Accepts only `https://host/path`, `ssh://[user@]host[:port]/path` and `user@host:path` (scp-like SSH). Everything
 * else is refused: `file://`, local paths, `git://`, `http://`, `ext::` and any other transport, credentials in the URL
 * (the clone uses this computer's own git credentials), a host that starts with `-` (an ssh option), query strings,
 * fragments, spaces and control characters. Returns null when refused.
 */
export function parseGitUrl(raw: unknown): GitUrl | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_LENGTH) return null
  if (CONTROL_OR_SPACE.test(raw) || raw.startsWith('-') || raw.includes('..')) return null
  const scp = SCP_LIKE.exec(raw)
  if (scp) {
    const [, , host, path] = scp
    if (!HOST.test(host!) || isLocalHost(host!) || path!.startsWith('-') || path!.includes('..')) return null
    const name = repoNameOf(path!)
    return name ? { kind: 'ssh', url: raw, repoName: name } : null
  }
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'ssh:') return null
  if (u.password || (u.protocol === 'https:' && u.username)) return null
  if (u.search || u.hash || raw.includes('?') || raw.includes('#')) return null
  const host = u.hostname
  if (!host || host.startsWith('-') || !(HOST.test(host) || /^\[[0-9a-f:.]+\]$/i.test(host)) || isLocalHost(host)) return null
  // A user that starts with `-` would reach ssh as an option.
  if (u.username && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(u.username)) return null
  const path = u.pathname
  if (path.length < 2 || !PATH_CHARS.test(path) || path.includes('..')) return null
  const name = repoNameOf(path)
  return name ? { kind: u.protocol === 'https:' ? 'https' : 'ssh', url: raw, repoName: name } : null
}

/** The folder name the clone goes to: the one asked for, else the repository's name. Null when not a valid name. */
export function directoryFor(url: GitUrl, wanted: string | undefined): string | null {
  const name = wanted ?? url.repoName
  return DIRECTORY.test(name) && !name.endsWith('.lock') ? name : null
}

/** Two URLs of the same remote: equal once a trailing `/` and `.git` are dropped. */
export function sameRemote(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '')
  return norm(a) === norm(b)
}

/**
 * The `url` of `[remote "origin"]` from a repository's `.git/config`, read as text: no git command runs in a folder
 * that was already there (its own config could make git run programs).
 */
export function originUrlOf(config: string): string | null {
  let inOrigin = false
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('[')) {
      inOrigin = /^\[remote\s+"origin"\]$/.test(line)
      continue
    }
    if (!inOrigin) continue
    const m = /^url\s*=\s*(.*)$/.exec(line)
    if (m) return m[1]!.replace(/^"(.*)"$/, '$1').trim()
  }
  return null
}

/** Variables that would point git at another repository or another config than the clone's own. */
const GIT_LOCATION_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE']

/** The environment git runs with: the plugin host's (without what belongs to the host), never prompting. */
export function gitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = cliEnv(env)
  for (const key of GIT_LOCATION_ENV) delete out[key]
  // A prompt nobody can answer would only wait for the timeout: fail at once instead.
  out.GIT_TERMINAL_PROMPT = '0'
  out.GCM_INTERACTIVE = 'never'
  // Transports that git allows only "from the user" (ext, fd...) are refused even if a config enables them.
  out.GIT_PROTOCOL_FROM_USER = '0'
  // git-lfs fetches with its own HTTP client, from the `lfs.url` a repository can set: no download during the clone.
  out.GIT_LFS_SKIP_SMUDGE = '1'
  return out
}

export type GitFn = (args: string[], timeoutMs: number) => Promise<ExecResult>

/**
 * Runs git in its own process group and, past the time limit, kills the whole group: `git clone` leaves the transfer
 * to children (`git-remote-https`, `ssh`, `index-pack`) that would otherwise keep writing after git itself is killed.
 */
export const defaultGit: GitFn = (args, timeoutMs) =>
  new Promise((resolve, reject) => {
    // `spawn`, not `execFile`: execFile drops `detached`, and the group is what lets the whole tree be killed.
    const group = process.platform !== 'win32'
    const child = spawn('git', args, { env: gitEnv(), windowsHide: true, shell: false, detached: group, stdio: ['ignore', 'pipe', 'pipe'] })
    const MAX = 256 * 1024
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout?.on('data', (d: unknown) => (stdout = (stdout + String(d)).slice(-MAX)))
    child.stderr?.on('data', (d: unknown) => (stderr = (stderr + String(d)).slice(-MAX)))
    let settled = false
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(() => {
      timedOut = true
      try {
        if (group && child.pid) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }
      // Do not wait for 'close': a process that left the group could keep the pipes open forever.
      settle(() => reject(Object.assign(new Error('git timed out'), { stdout, stderr, killed: true, signal: 'SIGKILL' })))
    }, timeoutMs)
    child.on('error', (error: Error & { code?: unknown }) => settle(() => reject(Object.assign(error, { stdout, stderr }))))
    child.on('close', (code: number | null, signal: string | null) =>
      settle(() => {
        if (timedOut) reject(Object.assign(new Error('git timed out'), { stdout, stderr, killed: true, signal: 'SIGKILL' }))
        else if (code === 0) resolve({ stdout, stderr })
        else reject(Object.assign(new Error(`git exited with ${code ?? signal}`), { stdout, stderr, code, signal: signal ?? undefined }))
      })
    )
  })

/**
 * The arguments of the clone. Only https and ssh transports are allowed for the clone itself and anything it could be
 * redirected to, submodules are not cloned, and `--` keeps the URL and the folder from being read as options.
 */
export function cloneArgs(url: string, dest: string, filters: readonly string[] = ['lfs']): string[] {
  // Every filter driver the user has configured (git-lfs, git-crypt...) is switched off for the checkout: a repository's
  // `.gitattributes` can name one, and a driver is a program with its own network access (git-lfs reads `lfs.url` from
  // the repository's `.lfsconfig`), outside `protocol.allow` and the host check. Files stay as committed (LFS pointers).
  const off = [...new Set(['lfs', ...filters])].flatMap((name) => [
    '-c', `filter.${name}.smudge=`,
    '-c', `filter.${name}.process=`,
    '-c', `filter.${name}.required=false`
  ])
  return [
    '-c', 'protocol.allow=never',
    '-c', 'protocol.https.allow=always',
    '-c', 'protocol.ssh.allow=always',
    '-c', 'submodule.recurse=false',
    ...off,
    'clone', '--quiet', '--no-recurse-submodules', '--', url, dest
  ]
}

/**
 * Names of the filter drivers in `git config --null --get-regexp` output (`<key>\n<value>\0` per entry, keys
 * `filter.<name>.<var>`); null when one cannot be passed back safely, so the clone is refused rather than run with it.
 */
export function filterNames(configList: string): string[] | null {
  const names = new Set<string>()
  for (const entry of configList.split('\0')) {
    if (!entry) continue
    const key = entry.split('\n', 1)[0] ?? ''
    const m = /^filter\.(.+)\.[A-Za-z0-9-]+$/i.exec(key)
    if (!m) continue
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(m[1]!)) return null
    names.add(m[1]!)
  }
  return [...names].slice(0, 50)
}

/** The filter drivers git would run for this user: from `git config --get-regexp ^filter\.` (exit 1 = none). */
export async function configuredFilters(git: GitFn): Promise<string[] | null> {
  try {
    return filterNames((await git(['config', '--null', '--get-regexp', '^filter\\.'], 10_000)).stdout)
  } catch (error) {
    const e = error as { code?: unknown; stdout?: unknown }
    if (e.code === 1) return []
    return null
  }
}

export type AddFailure = { code: 'forbidden' | 'invalid_args' | 'conflict' | 'timeout' | 'failed'; message: string }

/** Local paths stay on this computer: an absolute path in a message becomes `<path>`. */
const scrub = (text: string, max: number): string =>
  text.replace(/(?:[A-Za-z]:\\|\/)[^\s'"]+/g, '<path>').replace(/\s+/g, ' ').trim().slice(0, max)

/** The clone root the user configured, resolved through symlinks; a failure says why, without the path. */
export async function resolveRoot(configured: unknown): Promise<{ ok: true; root: string } | { ok: false; failure: AddFailure }> {
  const off: AddFailure = { code: 'forbidden', message: 'adding projects is not set up on this Orca: the user has to choose a clone folder in the plugin settings' }
  if (typeof configured !== 'string' || !configured.trim()) return { ok: false, failure: off }
  const path = configured.trim()
  if (!isAbsolute(path)) return { ok: false, failure: { code: 'forbidden', message: 'the clone folder in the plugin settings must be an absolute path' } }
  try {
    const root = await realpath(path)
    if (!(await stat(root)).isDirectory()) throw new Error('not a directory')
    return { ok: true, root }
  } catch {
    return { ok: false, failure: { code: 'forbidden', message: 'the clone folder in the plugin settings does not exist or is not a folder' } }
  }
}

/** What is at `dest` before cloning: nothing, a repository of the same remote, or something else. */
export async function inspectDestination(dest: string, url: string): Promise<'absent' | 'same_repo' | AddFailure> {
  let info
  try {
    info = await lstat(dest)
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return 'absent'
    return { code: 'failed', message: 'the destination folder cannot be read' }
  }
  if (info.isSymbolicLink()) return { code: 'forbidden', message: 'the destination is a symbolic link: nothing is written through links' }
  if (!info.isDirectory()) return { code: 'conflict', message: 'a file with that name already exists in the clone folder' }
  let gitDir
  try {
    gitDir = await lstat(join(dest, '.git'))
  } catch {
    return { code: 'conflict', message: 'a folder with that name already exists in the clone folder and is not a Git repository' }
  }
  if (gitDir.isSymbolicLink() || !gitDir.isDirectory()) {
    return { code: 'conflict', message: 'a folder with that name already exists and is not a plain Git repository' }
  }
  let origin: string | null = null
  try {
    origin = originUrlOf((await readFile(join(dest, '.git', 'config'), 'utf8')).slice(0, 64 * 1024))
  } catch {
    origin = null
  }
  if (origin && sameRemote(origin, url)) return 'same_repo'
  return { code: 'conflict', message: 'a repository with that name but another origin already exists in the clone folder: choose another directory' }
}

/** `dest` must still be exactly `<root>/<name>`, with no link on the way, once it exists. */
export async function insideRoot(root: string, dest: string): Promise<boolean> {
  try {
    const real = await realpath(dest)
    return real === dest && real.startsWith(root.endsWith(sep) ? root : root + sep)
  } catch {
    return false
  }
}

/** Clones into a temporary folder next to the destination and renames it at the end: a failure leaves nothing behind. */
export async function cloneInto(git: GitFn, root: string, dest: string, url: string): Promise<{ ok: true } | { ok: false; failure: AddFailure }> {
  const filters = await configuredFilters(git)
  if (!filters) return { ok: false, failure: { code: 'failed', message: 'the git configuration of this computer has a filter driver that cannot be switched off safely; nothing was cloned' } }
  const temp = join(root, TEMP_PREFIX + randomBytes(6).toString('hex'))
  const cleanup = () => rm(temp, { recursive: true, force: true }).catch(() => undefined)
  try {
    await git(cloneArgs(url, temp, filters), CLONE_TIMEOUT_MS)
  } catch (error) {
    await cleanup()
    const e = error as { killed?: boolean; signal?: string; code?: unknown; stderr?: unknown }
    if (e.code === 'ENOENT') return { ok: false, failure: { code: 'failed', message: 'git is not installed or not in the PATH of Orca' } }
    if (e.killed || e.signal === 'SIGKILL' || e.signal === 'SIGTERM') {
      return { ok: false, failure: { code: 'timeout', message: `the clone took longer than ${CLONE_TIMEOUT_MS / 1000} s and was cancelled; nothing was kept` } }
    }
    const last = typeof e.stderr === 'string' ? e.stderr.trim().split('\n').filter(Boolean).pop() ?? '' : ''
    return { ok: false, failure: { code: 'failed', message: `git could not clone the repository${last ? `: ${scrub(last, 200)}` : ''}` } }
  }
  try {
    // A folder of that name may have appeared while cloning: never replace it.
    if ((await inspectDestination(dest, url)) !== 'absent') {
      await cleanup()
      return { ok: false, failure: { code: 'conflict', message: 'a folder with that name appeared in the clone folder while cloning' } }
    }
    await rename(temp, dest)
  } catch {
    await cleanup()
    return { ok: false, failure: { code: 'failed', message: 'the clone could not be moved to its folder' } }
  }
  return { ok: true }
}
