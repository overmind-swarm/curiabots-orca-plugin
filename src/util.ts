// Small pure helpers shared by the worker modules. Nothing here touches Orca.

/** Exponential backoff with jitter: 1 s doubling up to 5 min, never below half the step. */
export function backoffDelay(
  attempt: number,
  random: () => number = Math.random,
  baseMs = 1000,
  capMs = 300_000
): number {
  const step = Math.min(capMs, baseMs * 2 ** Math.min(Math.max(attempt, 0), 20))
  return Math.round(step / 2 + random() * (step / 2))
}

export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/** Keeps the end of `text` within `maxBytes` of UTF-8. */
export function truncateTailBytes(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text
  const cut = Buffer.from(text, 'utf8').subarray(-maxBytes).toString('utf8')
  return cut.replace(/^�+/, '')
}

// ANSI CSI/OSC sequences and C0 controls other than tab and newline.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b./g
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g

export function sanitizeLine(line: string): string {
  return line.replace(ANSI, '').replace(CONTROL, '').replace(/\s+$/, '')
}

/** Lines of `read_output`, bounded in total size, keeping the newest. */
export function boundLines(
  lines: readonly string[],
  maxBytes = 128 * 1024,
  maxLineChars = 2000
): { lines: string[]; truncated: boolean } {
  const out: string[] = []
  let total = 0
  let truncated = false
  for (let i = lines.length - 1; i >= 0; i--) {
    let line = sanitizeLine(lines[i] ?? '')
    if (line.length > maxLineChars) {
      line = line.slice(0, maxLineChars)
      truncated = true
    }
    total += byteLength(line) + 1
    if (total > maxBytes) {
      truncated = true
      break
    }
    out.push(line)
  }
  return { lines: out.reverse(), truncated }
}

export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\s+/g, ' ').slice(0, 200)
}

export function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
