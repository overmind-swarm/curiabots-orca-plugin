import { randomUUID } from 'node:crypto'
import type { ExecFn } from '../src/cli.ts'
import { Plugin } from '../src/plugin.ts'
import type { PanelState } from '../src/plugin.ts'
import { FakeHost } from './fake-host.ts'
import { FakeSkill, until } from './fake-skill.ts'

export const FAST = {
  helloTimeoutMs: 500,
  connectTimeoutMs: 500,
  watchdogMs: 5000,
  resendMs: 5000,
  backoffBaseMs: 20,
  backoffCapMs: 80,
  projectsPollMs: 3_600_000
}

export interface Harness {
  skill: FakeSkill
  host: FakeHost
  plugin: Plugin
  execCalls: { file: string; args: string[] }[]
  states: PanelState[]
  /** What `orca terminal show` reports for any terminal. */
  sendFails: string | null
  /** Makes `orca terminal close` fail like the real CLI (JSON on stdout, non-zero exit) with this code. */
  closeFails: string | null
  /** Workspaces `workspace.list` reports; `workspace.create` adds to it. */
  workspaces: Set<string>
  /** `sendFails` makes `orca terminal send` fail like the real CLI: JSON on stdout and a non-zero exit. */
  showReply: { agentIdentity: string | null; connected: boolean; writable: boolean }
  restart(): Promise<Plugin>
  restartWith(start: (plugin: Plugin) => Promise<void>): Promise<Plugin>
  link(linkId: string, token: string): Promise<void>
  allow(linkId: string, ids?: string[]): Promise<void>
  stop(): Promise<void>
  agentEvent(terminalId: string, state: string, extra?: Record<string, unknown>): void
}

export async function setup(options: { timing?: Partial<typeof FAST>; stabilizeMs?: number } = {}): Promise<Harness> {
  const skill = new FakeSkill()
  await skill.listen()
  const host = new FakeHost()
  host.settingValues = { serviceUrl: skill.baseUrl }
  let n = 0
  const workspaces = new Set<string>()
  host.handlers = {
    'project.list': () => ({
      projects: [
        { id: 'p1', name: 'Repo One', kind: 'git', hostId: 'local', path: '/work/one' },
        { id: 'p2', name: 'Repo Two', kind: 'git', hostId: 'local', path: '/work/two' },
        { id: 'p3', name: 'Remote', kind: 'git', hostId: 'ssh:box', path: '/srv/r' },
        { id: 'f1', name: 'Folder', kind: 'folder', hostId: 'local', path: '/f' }
      ],
      truncated: false
    }),
    'workspace.create': () => {
      n++
      workspaces.add(`identity:wt2:local:ws-${n}`)
      return { workspaceId: `identity:wt2:local:ws-${n}`, terminalId: `term_${n}` }
    },
    'workspace.list': () => ({
      workspaces: [...workspaces].map((id) => ({ id, kind: 'worktree', path: '/wt/' + id, branch: null, hostId: 'local' })),
      truncated: false
    }),
    'terminal.read': () => ({ lines: ['', 'building...', '\u001b[32mdone\u001b[0m', ''], truncated: false }),
    'terminal.close': () => ({ closed: true }),
    'terminal.list': (p) => ({ terminals: [{ id: 'term_' + String(p.workspaceId).split('ws-')[1] }], truncated: false }),
    'agents.list': () => ({ agents: [] })
  }
  const execCalls: { file: string; args: string[] }[] = []
  const exec: ExecFn = async (file, args) => {
    execCalls.push({ file, args })
    if (args[0] === 'status') {
      return { stdout: JSON.stringify({ ok: true, result: { runtime: { appVersion: '1.4.267' } } }), stderr: '' }
    }
    if (args[0] === 'terminal' && args[1] === 'show') {
      return { stdout: JSON.stringify({ ok: true, result: { terminal: { ...h.showReply } } }), stderr: '' }
    }
    if (args[0] === 'terminal' && args[1] === 'send' && h.sendFails) {
      throw Object.assign(new Error('Command failed'), {
        stdout: JSON.stringify({ ok: false, error: { code: h.sendFails, message: 'refused' } }),
        stderr: ''
      })
    }
    if (args[0] === 'terminal' && args[1] === 'close' && h.closeFails) {
      throw Object.assign(new Error('Command failed'), {
        stdout: JSON.stringify({ ok: false, error: { code: h.closeFails, message: 'refused' } }),
        stderr: ''
      })
    }
    return { stdout: JSON.stringify({ ok: true }), stderr: '' }
  }
  const states: PanelState[] = []
  const make = () =>
    new Plugin({
      host,
      pluginVersion: '0.1.0',
      platform: 'linux',
      hostname: 'laptop',
      newId: () => randomUUID(),
      newSocket: (url) => new (globalThis as any).WebSocket(url),
      fetchFn: fetch,
      exec,
      timing: { ...FAST, ...options.timing },
      jobTiming: { stabilizeMs: options.stabilizeMs ?? 60, reconcileMs: 3_600_000, graceMs: 0 },
      random: () => 0.5,
      now: Date.now,
      postState: (s) => void states.push(s)
    })
  const h: Harness = {
    skill,
    host,
    plugin: make(),
    execCalls,
    states,
    sendFails: null,
    closeFails: null,
    workspaces,
    showReply: { agentIdentity: 'claude', connected: true, writable: true },
    async restart() {
      h.plugin.dispose()
      h.plugin = make()
      await h.plugin.start()
      return h.plugin
    },
    async restartWith(start) {
      h.plugin.dispose()
      h.plugin = make()
      await start(h.plugin)
      return h.plugin
    },
    async link(linkId, token) {
      skill.allowPair(linkId, token)
      const res = await h.plugin.pair('ABCD2345', 'My laptop')
      if (!res.ok) throw new Error('pair failed: ' + res.error)
      await until(() => !!skill.connOf(linkId)?.hello, 3000, 'hello of ' + linkId)
      await until(() => h.plugin.store.link(linkId) !== undefined && h.statusOf(linkId) === 'online', 3000, 'online')
    },
    async allow(linkId, ids = ['p1']) {
      await h.plugin.setProjects(linkId, ids.map((id) => ({ id, host_id: id === 'p3' ? 'ssh:box' : 'local' })))
    },
    async stop() {
      h.plugin.dispose()
      await skill.close()
    },
    agentEvent(terminalId, state, extra = {}) {
      h.plugin.onAgentStatus({ terminalId, state, ...extra })
    }
  } as Harness & { statusOf(id: string): string }
  ;(h as any).statusOf = (id: string) => (h.plugin as any).conns.get(id)?.status
  await h.plugin.start()
  return h
}
