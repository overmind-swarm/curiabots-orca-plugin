// An in-memory stand-in for Orca's worker API, for tests that run the connector without Orca.
import type { HostPort } from '../src/host.ts'

export class FakeHost implements HostPort {
  store = new Map<string, unknown>()
  secretStore = new Map<string, string>()
  settingValues: Record<string, unknown> = {}
  logs: string[] = []
  calls: { method: string; params: any }[] = []
  protection: 'os-keyring' | 'unavailable' = 'os-keyring'
  handlers: Record<string, (params: any) => unknown | Promise<unknown>> = {}
  statusBar: any = null

  call = async (method: string, params: any = {}): Promise<any> => {
    this.calls.push({ method, params })
    if (method === 'secrets.protection') return { status: this.protection }
    if (method === 'statusBar.update') {
      this.statusBar = { ...this.statusBar, ...params }
      return { ok: true }
    }
    const h = this.handlers[method]
    if (!h) throw Object.assign(new Error('no handler for ' + method), { code: 'unknown_method' })
    return h(params)
  }
  callsOf(method: string) {
    return this.calls.filter((c) => c.method === method)
  }
  storage = {
    get: async (k: string) => (this.store.has(k) ? JSON.parse(JSON.stringify(this.store.get(k))) : null),
    set: async (k: string, v: unknown) => void this.store.set(k, JSON.parse(JSON.stringify(v))),
    delete: async (k: string) => void this.store.delete(k)
  }
  secrets = {
    get: async (k: string) => this.secretStore.get(k) ?? null,
    set: async (k: string, v: string) => void this.secretStore.set(k, v),
    delete: async (k: string) => void this.secretStore.delete(k)
  }
  settings = { get: async () => ({ ...this.settingValues }) }
  log = (m: string) => void this.logs.push(m)
}
