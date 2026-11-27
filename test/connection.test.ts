import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { until } from './fake-skill.ts'
import { setup } from './harness.ts'
import type { Harness } from './harness.ts'

let h: Harness
afterEach(async () => h?.stop())

const JOB1 = '11111111-1111-4111-8111-111111111111'
const TOKEN = 'tok_' + 'a'.repeat(40)
const start = { job_id: JOB1, project_id: 'p1', workspace_name: 'w', agent: 'claude', prompt: 'go' }
const status = () => (h.plugin as any).conns.get('link-a')?.status

test('the skill pings and the plugin pongs', async () => {
  h = await setup()
  await h.link('link-a', TOKEN)
  h.skill.send(h.skill.connOf('link-a')!, { v: 1, type: 'ping' })
  await until(() => h.skill.connOf('link-a')!.received.some((m) => m.type === 'pong'))
})

test('messages before welcome, with another version or malformed are ignored', async () => {
  h = await setup()
  await h.link('link-a', TOKEN)
  const conn = h.skill.connOf('link-a')!
  h.skill.send(conn, 'not json')
  h.skill.send(conn, { v: 2, type: 'command', id: 'x1', name: 'stop', args: { job_id: JOB1 } })
  h.skill.send(conn, { v: 1, type: 'command', id: 'bad id!', name: 'stop', args: {} })
  h.skill.send(conn, { v: 1, type: 'command', id: 'x2', name: 'stop', args: [] })
  await until(() => conn.received.some((m) => m.type === 'result' && m.re === 'x2'))
  assert.equal(conn.received.filter((m) => m.type === 'result').length, 1)
  assert.equal(conn.received.find((m) => m.re === 'x2').error.code, 'invalid_args')
})

test('reconnects with backoff after the server drops it and keeps the same installation id', async () => {
  h = await setup()
  await h.link('link-a', TOKEN)
  const first = h.skill.connOf('link-a')!
  h.skill.closeConn(first, 1012)
  await until(() => h.skill.conns.filter((c) => c.hello).length >= 2, 3000, 'second hello')
  await until(() => status() === 'online')
  assert.equal(h.skill.conns.at(-1)!.hello.installation_id, first.hello.installation_id)
})

test('hello carries the last issued event seq: 0 when none, and it survives a restart (dev#2401)', async () => {
  h = await setup()
  await h.link('link-a', TOKEN)
  assert.equal(h.skill.connOf('link-a')!.hello.last_seq, 0)
  h.plugin.store.enqueue('link-a', { kind: 'job.status', job_id: JOB1, state: 'working' } as any)
  h.plugin.store.enqueue('link-a', { kind: 'job.status', job_id: JOB1, state: 'idle' } as any)
  await until(() => ((h.host.store.get('outbox:link-a') as any)?.next_seq ?? 0) === 3)
  const before = h.skill.conns.length
  await h.restart()
  await until(() => h.skill.conns.length > before && !!h.skill.conns.at(-1)!.hello)
  assert.equal(h.skill.conns.at(-1)!.hello.last_seq, 2)
})

test('close code 4401 stops reconnecting and says so; the other link is unaffected', async () => {
  h = await setup()
  await h.link('link-a', TOKEN)
  await h.link('link-b', 'tok_' + 'b'.repeat(40))
  h.skill.tokens.delete(TOKEN) // the skill no longer knows it
  h.skill.closeConn(h.skill.connOf('link-a')!, 1012)
  await until(() => status() === 'unauthorized')
  const hellos = h.skill.conns.length
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(h.skill.conns.length, hellos, 'no further attempts')
  assert.equal((h.plugin as any).conns.get('link-b').status, 'online')
  const view = (await h.plugin.getState()).links.find((l) => l.link_id === 'link-a')!
  assert.equal(view.status, 'unauthorized')
})

test('events produced offline wait in the persistent outbox and are resent until acked', async () => {
  h = await setup()
  h.skill.autoAck = false
  await h.link('link-a', TOKEN)
  await h.allow('link-a')
  await h.skill.command('link-a', 'start_job', start)

  // go offline: drop the socket and keep the server from accepting a new one for a while
  h.skill.tokens.delete(TOKEN)
  h.skill.closeConn(h.skill.connOf('link-a')!, 1012)
  await until(() => status() === 'unauthorized')
  h.agentEvent('term_1', 'waiting')
  await until(() => h.plugin.store.outbox('link-a').events.length === 1)
  assert.equal(h.skill.events('link-a').length, 0)
  const persisted = h.host.store.get('outbox:link-a') as any
  await until(() => ((h.host.store.get('outbox:link-a') as any)?.events.length ?? 0) === 1)
  assert.equal(persisted.next_seq >= 1, true)

  // the app restarts; the skill is back and does not ack the first delivery
  h.skill.tokens.set(TOKEN, 'link-a')
  await h.restart()
  await until(() => h.skill.events('link-a').length === 1, 3000, 'resent after restart')
  assert.equal(h.skill.events('link-a')[0].seq, 1)
  assert.equal(h.skill.events('link-a')[0].event.state, 'waiting_user')
  assert.equal(h.plugin.store.outbox('link-a').events.length, 1, 'still waiting for the ack')

  // reconnect without ack: delivered again; with ack: gone
  h.skill.closeConn(h.skill.connOf('link-a')!, 1012)
  await until(() => h.skill.events('link-a').length === 2, 3000, 'resent after reconnect')
  h.skill.send(h.skill.connOf('link-a')!, { v: 1, type: 'ack', seq: 1 })
  await until(() => h.plugin.store.outbox('link-a').events.length === 0)
  await until(() => ((h.host.store.get('outbox:link-a') as any)?.events.length ?? 1) === 0)
  // the sequence keeps counting across restarts
  h.agentEvent('term_1', 'working')
  await until(() => h.plugin.store.outbox('link-a').events.length === 1)
  assert.equal(h.plugin.store.outbox('link-a').events[0]!.seq, 2)
})

test('past 500 events the outbox keeps the last status of each job and never drops terminal events', async () => {
  h = await setup()
  await h.link('link-a', TOKEN)
  h.skill.autoAck = false
  h.skill.tokens.delete(TOKEN)
  h.skill.closeConn(h.skill.connOf('link-a')!, 1012)
  await until(() => status() === 'unauthorized')
  const status_ = (job_id: string, state: string) =>
    ({ kind: 'job.status', job_id, state, orca_state: 'working', at: 1 }) as any
  const store = h.plugin.store
  // one chatty job: 300 statuses, then 1 failed and 1 gone elsewhere
  store.enqueue('link-a', status_('chatty', 'failed'))
  store.enqueue('link-a', { kind: 'job.gone', job_id: 'lost', reason: 'x' })
  for (let i = 0; i < 300; i++) store.enqueue('link-a', status_('chatty', i % 2 ? 'working' : 'idle'))
  assert.equal(store.outbox('link-a').events.length, 302, 'under the cap nothing is dropped')
  for (let i = 0; i < 300; i++) store.enqueue('link-a', status_('chatty', i % 2 ? 'working' : 'idle'))
  let events = store.outbox('link-a').events
  assert.ok(events.length <= 500)
  const chatty = events.filter((e) => e.event.kind === 'job.status' && e.event.job_id === 'chatty' && e.event.state !== 'failed')
  assert.ok(chatty.length < 300, 'compaction ran when the cap was passed')
  assert.equal(events.filter((e) => e.seq <= 302 && e.event.kind === 'job.status' && e.event.state !== 'failed').length, 0, 'the early chatty statuses were compacted away')
  assert.equal(chatty.at(-1)!.seq, 602, 'the newest status is kept')
  assert.ok(events.some((e) => e.event.kind === 'job.status' && e.event.state === 'failed'), 'terminal status kept')
  assert.ok(events.some((e) => e.event.kind === 'job.gone'), 'job.gone kept')
  assert.equal(events.at(-1)!.seq, 602, 'sequence numbers keep counting')
  // many distinct jobs: oldest non-terminal go first, terminal ones stay
  for (let i = 0; i < 600; i++) store.enqueue('link-a', status_('job' + i, 'working'))
  events = store.outbox('link-a').events
  assert.equal(events.length, 500)
  assert.ok(events.some((e) => e.event.kind === 'job.gone'))
  assert.ok(events.some((e) => e.event.kind === 'job.status' && e.event.state === 'failed'))
  assert.equal(events.at(-1)!.seq, 1202)
  // a server that never acks while jobs keep ending: terminal events are bounded too, without output
  for (let i = 0; i < 2600; i++) store.enqueue('link-a', { ...status_('end' + i, 'stopped'), excerpt: 'secret output' })
  events = store.outbox('link-a').events
  assert.equal(events.length, 2000)
  assert.equal(events.some((e) => e.event.kind === 'job.status' && e.event.excerpt !== undefined), false, 'no stored output past the cap')
})

test('failed starts do not pile up in storage', async () => {
  h = await setup()
  await h.link('link-a', TOKEN)
  await h.allow('link-a')
  h.host.handlers['workspace.create'] = () => {
    throw Object.assign(new Error('bad base'), { code: 'action_failed' })
  }
  for (let i = 0; i < 230; i++) {
    const r = await h.skill.command('link-a', 'start_job', { ...start, job_id: 'f' + String(i).padStart(10, '0') })
    assert.equal(r.error.code, 'internal')
  }
  assert.ok(Object.keys(h.plugin.store.jobsOf('link-a')).length <= 200)
})

test('jobs survive a restart: the terminal still maps to its job and the link', async () => {
  h = await setup()
  await h.link('link-a', TOKEN)
  await h.allow('link-a')
  await h.skill.command('link-a', 'start_job', start)
  await h.plugin.store.flush()
  await h.restart()
  await until(() => status() === 'online')
  h.agentEvent('term_1', 'waiting')
  await until(() => h.skill.events('link-a').length === 1)
  assert.equal(h.skill.events('link-a')[0].event.job_id, JOB1)
  const again = await h.skill.command('link-a', 'start_job', start)
  assert.equal(again.data.terminal_id, 'term_1', 'idempotent across restarts')
  assert.equal(h.host.callsOf('workspace.create').length, 1)
})

test('a start that died mid-way is never guessed at', async () => {
  h = await setup()
  await h.link('link-a', TOKEN)
  await h.allow('link-a')
  h.plugin.store.jobsOf('link-a')[JOB1] = {
    job_id: JOB1, link_id: 'link-a', project_id: 'p1', host_id: 'local', workspace_id: null, terminal_id: null,
    session_id: null, phase: 'creating', orca_state: null, outcome: null, last_emitted: null, last_hash: null,
    agent: 'claude', created_at: 1, updated_at: 1
  }
  const r = await h.skill.command('link-a', 'start_job', start)
  assert.equal(r.error.code, 'failed')
  const again = await h.skill.command('link-a', 'start_job', start)
  assert.equal(again.error.code, 'failed', 'it stays failed: a retry needs a new job_id')
  assert.equal(h.host.callsOf('workspace.create').length, 0, 'never a second worktree')
})

test('revoked: secret deleted, no reconnect, link kept only to be removed', async () => {
  h = await setup()
  await h.link('link-a', TOKEN)
  h.skill.send(h.skill.connOf('link-a')!, { v: 1, type: 'revoked', reason: 'user' })
  await until(() => h.plugin.store.link('link-a')?.revoked === true)
  assert.equal(h.host.secretStore.has('link:link-a'), false)
  const n = h.skill.conns.length
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(h.skill.conns.length, n)
  assert.equal((await h.plugin.getState()).links[0]!.status, 'revoked')
  assert.equal(await h.plugin.unlink('link-a'), true)
  assert.equal(h.plugin.store.links.length, 0)
})

test('unlinking tells the skill, wipes secret, jobs and outbox, and leaves the agents running', async () => {
  h = await setup()
  await h.link('link-a', TOKEN)
  await h.allow('link-a')
  await h.skill.command('link-a', 'start_job', start)
  const conn = h.skill.connOf('link-a')!
  assert.equal(await h.plugin.unlink('link-a'), true)
  await until(() => conn.received.some((m) => m.type === 'unlink'))
  assert.equal(h.host.secretStore.size, 0)
  assert.equal(h.host.store.has('jobs:link-a'), false)
  assert.equal(h.host.store.has('outbox:link-a'), false)
  assert.equal(h.host.callsOf('terminal.close').length, 0)
  assert.deepEqual((h.host.store.get('links') as any[]).length, 0)
})

test('a dead link (no ping) is dropped by the watchdog and reconnected', async () => {
  h = await setup({ timing: { watchdogMs: 120 } })
  await h.link('link-a', TOKEN)
  await until(() => h.skill.conns.filter((c) => c.hello).length >= 2, 3000, 'reconnect after silence')
})

test('allowed projects are sent in hello and when they change', async () => {
  h = await setup()
  await h.link('link-a', TOKEN)
  await h.allow('link-a', ['p1', 'p3', 'f1', 'nope'])
  await until(() => h.skill.connOf('link-a')!.received.some((m) => m.type === 'projects'))
  const msg = h.skill.connOf('link-a')!.received.find((m) => m.type === 'projects')
  assert.deepEqual(msg.projects, [
    { id: 'p1', name: 'Repo One', host_id: 'local' },
    { id: 'p3', name: 'Remote', host_id: 'ssh:box' }
  ])
  const before = h.skill.conns.length
  await h.restart()
  await until(() => h.skill.conns.length > before && !!h.skill.conns.at(-1)!.hello)
  assert.equal(h.skill.conns.at(-1)!.hello.projects.length, 2)
})

test('a start that fails once (storage refused for a moment) is retried instead of leaving a dead plugin', async () => {
  const { startWithRetry } = await import('../src/worker.ts')
  h = await setup()
  await h.link('link-a', TOKEN)
  h.plugin.dispose()
  let failures = 1
  const realGet = h.host.storage.get
  h.host.storage.get = async (k: string) => {
    if (failures-- > 0) throw Object.assign(new Error('plugin is not enabled with current consent'), { code: 'consent_required' })
    return realGet(k)
  }
  const before = h.skill.conns.length
  await h.restartWith((plugin) => startWithRetry(plugin, h.host))
  await until(() => h.skill.conns.length > before && !!h.skill.conns.at(-1)!.hello, 4000, 'hello after the retry')
  assert.ok(h.host.logs.some((l) => l.startsWith('start.failed')))
  assert.equal((await h.plugin.getState()).links.length, 1)
})
