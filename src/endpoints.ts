// The service base URL is a setting, so it is validated like untrusted input: https only
// (plain http/ws is allowed for loopback, which is what the tests and local development use).
export const DEFAULT_SERVICE_URL = 'https://api.curiabots.com/skills/orca'

export interface Endpoints {
  base: string
  pairUrl: string
  wsUrl: string
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export function resolveEndpoints(input: string | undefined): Endpoints | null {
  const raw = (input && input.trim()) || DEFAULT_SERVICE_URL
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.username || url.password || url.search || url.hash) return null
  const secure = url.protocol === 'https:'
  const plainLoopback = url.protocol === 'http:' && LOOPBACK.has(url.hostname)
  if (!secure && !plainLoopback) return null
  const base = `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`
  const ws = base.replace(/^http/, 'ws')
  return { base, pairUrl: `${base}/connector/pair`, wsUrl: `${ws}/connector` }
}
