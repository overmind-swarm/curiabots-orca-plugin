// The slice of Orca's worker API this plugin uses. Keeping it narrow lets the logic run (and be
// tested) without Orca; worker.ts adapts the real `orca` object to it.
export interface HostPort {
  call(method: string, params?: Record<string, unknown>): Promise<any>
  storage: {
    get(key: string): Promise<unknown>
    set(key: string, value: any): Promise<void>
    delete(key: string): Promise<void>
  }
  secrets: {
    get(key: string): Promise<string | null>
    set(key: string, value: string): Promise<void>
    delete(key: string): Promise<void>
  }
  settings: { get(): Promise<Record<string, unknown>> }
  log(message: string): void
}

const FORBIDDEN_LOG_KEYS = /token|code|prompt|text|excerpt|lines|secret|output|password/i

/** Structured, content-free log line: identifiers, sizes and states only. */
export function logLine(host: HostPort, event: string, fields: Record<string, unknown> = {}): void {
  const parts = [event]
  for (const [key, value] of Object.entries(fields)) {
    if (FORBIDDEN_LOG_KEYS.test(key) && !/^(code_len|text_bytes|prompt_bytes|token_in_storage|error_code)$/.test(key)) continue
    if (value === undefined || value === null) continue
    const printable = typeof value === 'string' ? value.slice(0, 120) : String(value)
    parts.push(`${key}=${printable.replace(/\s+/g, '_')}`)
  }
  try {
    host.log(parts.join(' '))
  } catch {
    /* logging must never throw */
  }
}
