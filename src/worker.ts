// Orca worker entry. Orca keeps this process alive while the plugin is enabled (the status bar
// item makes that so), so the sockets stay open. A save restarts it; everything that must survive
// lives in storage / secrets.
import type { OrcaWorkerApi } from 'orca/worker'
import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { HostPort } from './host.ts'
import { logLine } from './host.ts'
import { DEFAULT_JOB_TIMING } from './jobs.ts'
import { DEFAULT_TIMING } from './link.ts'
import { Plugin } from './plugin.ts'
import type { SocketLike } from './link.ts'
import { errorMessage } from './util.ts'
import { PLUGIN_VERSION } from './version.ts'
import './protocol.ts'

function adapt(orca: OrcaWorkerApi): HostPort {
  return {
    call: (method, params) => (orca.host.call as any)(method, params ?? {}),
    storage: {
      get: (key) => orca.storage.get(key),
      set: (key, value) => orca.storage.set(key, value),
      delete: (key) => orca.storage.delete(key)
    },
    secrets: {
      get: (key) => orca.secrets.get(key),
      set: (key, value) => orca.secrets.set(key, value),
      delete: (key) => orca.secrets.delete(key)
    },
    settings: { get: () => orca.settings.get() as Promise<Record<string, unknown>> },
    log: (message) => orca.log(message)
  }
}

let current: Plugin | null = null

export default function activate(orca: OrcaWorkerApi): void {
  const host = adapt(orca)
  const plugin = new Plugin({
    host,
    pluginVersion: PLUGIN_VERSION,
    platform: process.platform,
    hostname: safeHostname(),
    newId: () => randomUUID(),
    newSocket: (url) => new (globalThis as any).WebSocket(url) as SocketLike,
    fetchFn: (input, init) => fetch(input, init),
    timing: DEFAULT_TIMING,
    jobTiming: DEFAULT_JOB_TIMING,
    random: Math.random,
    now: Date.now,
    postState: (state) => {
      try {
        ;(orca.panels.post as any)('state.changed', state)
      } catch {
        /* no panel open */
      }
    }
  })
  current = plugin
  const ready = startWithRetry(plugin, host)

  orca.events.on('agent.status.changed', (payload) => {
    void ready.then(() => plugin.onAgentStatus(payload as any))
  })
  orca.events.on('workspace.created', () => {
    void ready.then(() => plugin.onWorkspaceCreated())
  })
  orca.events.on('workspace.removed', (payload) => {
    void ready.then(() => plugin.onWorkspaceRemoved(payload as any))
  })

  orca.panels.handle('state.get', async () => {
    await ready
    return plugin.getState()
  })
  orca.panels.handle('link.pair', async (input) => {
    await ready
    return plugin.pair(String(input?.code ?? ''), input?.host_label)
  })
  orca.panels.handle('link.unlink', async (input) => {
    await ready
    return { ok: await plugin.unlink(String(input?.link_id ?? '')) }
  })
  orca.panels.handle('link.projects.set', async (input) => {
    await ready
    const wanted = Array.isArray(input?.projects)
      ? input.projects
          .filter((p) => p && typeof p.id === 'string' && typeof p.host_id === 'string')
          .slice(0, 500)
          .map((p) => ({ id: p.id, host_id: p.host_id }))
      : []
    return { ok: await plugin.setProjects(String(input?.link_id ?? ''), wanted) }
  })
  orca.panels.handle('link.projects.allowAll', async (input) => {
    await ready
    return { ok: await plugin.setAllowAll(String(input?.link_id ?? ''), input?.on === true) }
  })
  orca.panels.handle('projects.list', async () => {
    await ready
    try {
      return { ok: true, projects: await plugin.listProjects() }
    } catch (error) {
      logLine(host, 'projects.list_failed', { error: errorMessage(error) })
      return { ok: false, projects: [] }
    }
  })
}

/** Starting reads storage, which Orca can refuse for a moment (for example while a reload re-checks consent). */
export async function startWithRetry(plugin: Plugin, host: HostPort): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await plugin.start()
      return
    } catch (error) {
      logLine(host, 'start.failed', { attempt, error: errorMessage(error) })
      if (plugin.isDisposed) return
      await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 500 * 2 ** Math.min(attempt, 6))))
    }
  }
}

export function deactivate(): void {
  current?.dispose()
  current = null
}

function safeHostname(): string {
  try {
    return hostname() || 'Orca'
  } catch {
    return 'Orca'
  }
}
