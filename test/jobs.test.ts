import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { until } from './fake-skill.ts'
import { setup } from './harness.ts'
import type { Harness } from './harness.ts'

let h: Harness
afterEach(async () => h?.stop())

const JOB1 = '11111111-1111-4111-8111-111111111111'
const JOB2 = '22222222-2222-4222-8222-222222222222'
const JOB3 = '33333333-3333-4333-8333-333333333333'
const start = (job_id: string, extra: Record<string, unknown> = {}) => ({
  job_id,
  project_id: 'p1',
  workspace_name: 'fix-2357',
  base_branch: 'main',
  agent: 'claude',
  prompt: 'Analyse issue 2357 and fix it',
  ...extra
})

async function twoLinks() {
  h = await setup()
  await h.link('link-a', 'tok_' + 'a'.repeat(40))
  await h.link('link-b', 'tok_' + 'b'.repeat(40))
  await h.allow('link-a', ['p1', 'p3'])
  await h.allow('link-b', ['p2'])
}

test('start_job launches the agent in an allowed project and is idempotent by job_id', async () => {
  h = await setup()
  await h.link('link-a', 'tok_' + 'a'.repeat(40))
  await h.allow('link-a', ['p1'])
  const r1 = await h.skill.command('link-a', 'start_job', start(JOB1))
  assert.equal(r1.ok, true)
  assert.deepEqual(r1.data, { workspace_id: 'identity:wt2:local:ws-1', terminal_id: 'term_1' })
  assert.deepEqual(h.host.callsOf('workspace.create')[0]!.params, {
    projectId: 'p1',
    hostId: 'local',
    name: 'fix-2357',
    agent: 'claude',
    prompt: 'Analyse issue 2357 and fix it',
    baseBranch: 'main'
  })
  const r2 = await h.skill.command('link-a', 'start_job', start(JOB1))
  assert.deepEqual(r2.data, r1.data)
  assert.equal(h.host.callsOf('workspace.create').length, 1, 'no second worktree')

  // two concurrent starts with the same id still create one
  const [a, b] = await Promise.all([
    h.skill.command('link-a', 'start_job', start(JOB2)),
    h.skill.command('link-a', 'start_job', start(JOB2))
  ])
  const results = [a, b].sort((x, y) => Number(y.ok) - Number(x.ok))
  assert.equal(results[0]!.ok, true)
  assert.equal(results[1]!.error.code, 'in_progress', 'the second one is told it is still in progress')
  assert.equal(h.host.callsOf('workspace.create').length, 2)
  assert.deepEqual((await h.skill.command('link-a', 'start_job', start(JOB2))).data, results[0]!.data)
})

test('start_job outside the allowed projects is rejected on this machine', async () => {
  h = await setup()
  await h.link('link-a', 'tok_' + 'a'.repeat(40))
  let r = await h.skill.command('link-a', 'start_job', start(JOB1))
  assert.equal(r.error.code, 'forbidden', 'no project allowed yet')
  await h.allow('link-a', ['p1'])
  r = await h.skill.command('link-a', 'start_job', start(JOB1, { project_id: 'p2' }))
  assert.equal(r.error.code, 'forbidden')
  r = await h.skill.command('link-a', 'start_job', start(JOB1, { host_id: 'ssh:box' }))
  assert.equal(r.error.code, 'forbidden', 'right project id, wrong host')
  assert.equal(h.host.callsOf('workspace.create').length, 0)
})

test('start_job validates its arguments', async () => {
  h = await setup()
  await h.link('link-a', 'tok_' + 'a'.repeat(40))
  await h.allow('link-a')
  for (const bad of [
    start('short'),
    start(JOB1, { agent: 'claude; rm -rf /' }),
    start(JOB1, { base_branch: '--upload-pack=x' }),
    start(JOB1, { base_branch: 'a..b' }),
    start(JOB1, { prompt: '' }),
    start(JOB1, { prompt: 'x'.repeat(16 * 1024 + 1) }),
    start(JOB1, { workspace_name: 'a\nb' }),
    start(JOB1, { project_id: 5 })
  ]) {
    const r = await h.skill.command('link-a', 'start_job', bad)
    assert.equal(r.ok, false)
    assert.equal(r.error.code, 'invalid_args', JSON.stringify(bad).slice(0, 80))
  }
  const unknown = await h.skill.command('link-a', 'run_shell', { cmd: 'id' })
  assert.equal(unknown.error.code, 'invalid_args')
  assert.equal(h.host.callsOf('workspace.create').length, 0)
})

test('limits: per link (from welcome, capped locally) and in total', async () => {
  h = await setup()
  h.skill.welcomeLimits = { max_jobs: 2, max_prompt_bytes: 16384 }
  await h.link('link-a', 'tok_' + 'a'.repeat(40))
  await h.allow('link-a')
  const ids = [JOB1, JOB2, JOB3]
  const results = []
  for (const id of ids) results.push(await h.skill.command('link-a', 'start_job', start(id)))
  assert.deepEqual(results.map((r) => r.ok), [true, true, false])
  assert.equal(results[2].error.code, 'limit_reached')
  await h.skill.command('link-a', 'stop', { job_id: JOB1 })
  const again = await h.skill.command('link-a', 'start_job', start(JOB3))
  assert.equal(again.ok, true, 'a stopped job frees its slot')
})

test('two links on one plugin never see or touch each other: jobs, projects and events', async () => {
  await twoLinks()
  const a = await h.skill.command('link-a', 'start_job', start(JOB1))
  assert.equal(a.ok, true)
  const b = await h.skill.command('link-b', 'start_job', start(JOB2, { project_id: 'p2' }))
  assert.equal(b.ok, true)
  // B reaches for A's job in every way
  for (const [name, args] of [
    ['get_job', { job_id: JOB1 }],
    ['read_output', { job_id: JOB1, tail_lines: 10 }],
    ['send', { job_id: JOB1, text: 'hi', enter: true }],
    ['stop', { job_id: JOB1 }],
    ['start_job', start(JOB1, { project_id: 'p2' })]
  ] as const) {
    const r = await h.skill.command('link-b', name, args)
    assert.equal(r.error?.code, 'forbidden', name)
  }
  // B cannot use A's project; A cannot use B's
  assert.equal((await h.skill.command('link-b', 'start_job', start(JOB3, { project_id: 'p1' }))).error.code, 'forbidden')
  assert.equal((await h.skill.command('link-a', 'start_job', start(JOB3, { project_id: 'p2' }))).error.code, 'forbidden')
  assert.equal(h.host.callsOf('terminal.close').length, 0)
  assert.equal(h.execCalls.filter((c) => c.args[0] === 'terminal').length, 0)

  // events from A's terminal reach only A's socket; an unrelated terminal reaches nobody
  h.agentEvent('term_1', 'working')
  h.agentEvent('term_999', 'working')
  await until(() => h.skill.events('link-a').length === 1)
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(h.skill.events('link-b').length, 0)
  assert.equal(h.skill.events('link-a')[0].event.job_id, JOB1)

  // unlinking A leaves B intact
  await h.plugin.unlink('link-a')
  assert.ok(h.skill.connOf('link-b'))
  assert.equal((await h.skill.command('link-b', 'get_job', { job_id: JOB2 })).ok, true)
  assert.equal(h.host.secretStore.has('link:link-a'), false)
  assert.equal(h.host.secretStore.has('link:link-b'), true)
})

test('job.status is stabilised for 5 s (here 60 ms), never repeated, with a bounded excerpt', async () => {
  h = await setup()
  await h.link('link-a', 'tok_' + 'a'.repeat(40))
  await h.allow('link-a')
  await h.skill.command('link-a', 'start_job', start(JOB1))
  // bounce: done -> working -> waiting -> working inside the window
  h.agentEvent('term_1', 'done', { mainAgent: { state: 'done' } })
  h.agentEvent('term_1', 'working')
  h.agentEvent('term_1', 'waiting')
  h.agentEvent('term_1', 'working')
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(h.skill.events('link-a').length, 0, 'nothing before the window ends')
  await until(() => h.skill.events('link-a').length === 1)
  const first = h.skill.events('link-a')[0]
  assert.equal(first.seq, 1)
  assert.equal(first.event.state, 'working')
  assert.equal(first.event.excerpt, undefined, 'no excerpt while working')

  h.agentEvent('term_1', 'working') // same state again: nothing new
  h.agentEvent('term_1', 'waiting', { sessionId: 's1' })
  await until(() => h.skill.events('link-a').length === 2)
  const waiting = h.skill.events('link-a')[1]
  assert.equal(waiting.event.state, 'waiting_user')
  assert.equal(waiting.event.orca_state, 'waiting')
  assert.equal(waiting.event.excerpt, 'building...\ndone', 'ANSI stripped, blanks dropped')
  assert.equal(typeof waiting.event.at, 'number')

  h.agentEvent('term_1', 'done', { mainAgent: { state: 'done', outcome: 'failure' } })
  await until(() => h.skill.events('link-a').length === 3)
  assert.equal(h.skill.events('link-a')[2].event.state, 'failed')
  assert.equal(h.skill.events('link-a')[2].event.outcome, 'failure')
  h.agentEvent('term_1', 'done', { mainAgent: { state: 'done', outcome: 'success' } })
  await until(() => h.skill.events('link-a').length === 4)
  assert.equal(h.skill.events('link-a')[3].event.state, 'idle')
  const seqs = h.skill.events('link-a').map((e) => e.seq)
  assert.deepEqual(seqs, [1, 2, 3, 4])
})

test('get_job, read_output, send (via the CLI) and stop', async () => {
  h = await setup()
  await h.link('link-a', 'tok_' + 'a'.repeat(40))
  await h.allow('link-a')
  await h.skill.command('link-a', 'start_job', start(JOB1))
  h.host.handlers['agents.list'] = () => ({ agents: [{ terminalId: 'term_1', state: 'waiting', title: 't', agent: 'claude', stateStartedAt: 1 }] })
  const got = await h.skill.command('link-a', 'get_job', { job_id: JOB1 })
  assert.equal(got.data.state, 'waiting_user')
  assert.equal(got.data.orca_state, 'waiting')
  assert.equal(got.data.excerpt, 'building...\ndone')

  h.host.handlers['terminal.read'] = (p) => ({ lines: Array.from({ length: p.maxLines }, (_, i) => 'l' + i), truncated: true })
  const out = await h.skill.command('link-a', 'read_output', { job_id: JOB1, tail_lines: 99999 })
  assert.equal(out.data.lines.length, 400, 'clamped to 400')
  assert.equal(out.data.truncated, true)
  assert.equal(h.host.callsOf('terminal.read').at(-1)!.params.maxLines, 400)

  const sent = await h.skill.command('link-a', 'send', { job_id: JOB1, text: '--rm -rf; $(id)', enter: true })
  assert.deepEqual(sent.data, { accepted: true })
  const call = h.execCalls.at(-1)!
  assert.deepEqual(call.args, ['terminal', 'send', '--terminal', 'term_1', '--text=--rm -rf; $(id)', '--enter', '--json'])
  assert.equal((await h.skill.command('link-a', 'send', { job_id: JOB1, text: 'x', enter: 'yes' })).error.code, 'invalid_args')

  const stopped = await h.skill.command('link-a', 'stop', { job_id: JOB1 })
  assert.deepEqual(stopped.data, { stopped: true })
  assert.deepEqual(h.host.callsOf('terminal.close')[0]!.params, { terminalId: 'term_1' })
  await until(() => h.skill.events('link-a').some((e) => e.event.state === 'stopped'))
  assert.deepEqual((await h.skill.command('link-a', 'stop', { job_id: JOB1 })).data, { stopped: true }, 'idempotent')
  assert.equal(h.host.callsOf('terminal.close').length, 1)
  assert.equal((await h.skill.command('link-a', 'read_output', { job_id: JOB1, tail_lines: 5 })).error.code, 'not_found')
  assert.equal((await h.skill.command('link-a', 'get_job', { job_id: JOB1 })).data.state, 'stopped')
})

test('after a reply the next stable state is reported even if it equals the last one', async () => {
  h = await setup()
  await h.link('link-a', 'tok_' + 'a'.repeat(40))
  await h.allow('link-a')
  await h.skill.command('link-a', 'start_job', start(JOB1))
  h.agentEvent('term_1', 'done', { mainAgent: { state: 'done', outcome: 'success' } })
  await until(() => h.skill.events('link-a').length === 1)
  h.agentEvent('term_1', 'done', { mainAgent: { state: 'done', outcome: 'success' } })
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(h.skill.events('link-a').length, 1, 'no repeat on its own')
  assert.equal((await h.skill.command('link-a', 'send', { job_id: JOB1, text: 'continue', enter: true })).ok, true)
  h.agentEvent('term_1', 'working')
  h.agentEvent('term_1', 'done', { mainAgent: { state: 'done', outcome: 'success' } })
  await until(() => h.skill.events('link-a').length === 2)
  assert.equal(h.skill.events('link-a')[1].event.state, 'idle')
})

test('send without a working CLI answers cli_unavailable and hello does not announce it', async () => {
  h = await setup()
  ;(h.plugin.cli as any).exec = async () => {
    throw new Error('not found')
  }
  await h.link('link-a', 'tok_' + 'a'.repeat(40))
  assert.deepEqual(h.skill.connOf('link-a')!.hello.capabilities, [])
  await h.allow('link-a')
  await h.skill.command('link-a', 'start_job', start(JOB1))
  h.agentEvent('term_1', 'done')
  const r = await h.skill.command('link-a', 'send', { job_id: JOB1, text: 'x', enter: false })
  assert.equal(r.error.code, 'cli_unavailable')
})

test('a vanished terminal or removed workspace emits job.gone', async () => {
  h = await setup()
  await h.link('link-a', 'tok_' + 'a'.repeat(40))
  await h.allow('link-a')
  await h.skill.command('link-a', 'start_job', start(JOB1))
  await h.skill.command('link-a', 'start_job', start(JOB2))
  h.host.handlers['terminal.list'] = (p) =>
    String(p.workspaceId).endsWith('ws-1') ? { terminals: [], truncated: false } : { terminals: [{ id: 'term_2' }], truncated: false }
  await h.plugin.jobs.reconcile()
  await until(() => h.skill.events('link-a').some((e) => e.event.kind === 'job.gone'))
  const gone = h.skill.events('link-a').find((e) => e.event.kind === 'job.gone')
  assert.deepEqual(gone.event, { kind: 'job.gone', job_id: JOB1, reason: 'terminal_closed' })
  h.plugin.onWorkspaceRemoved({ workspaceListId: 'identity:wt2:local:ws-2' })
  await until(() => h.skill.events('link-a').filter((e) => e.event.kind === 'job.gone').length === 2)
  assert.equal(h.plugin.jobs.activeCount(), 0)
  assert.equal((await h.skill.command('link-a', 'get_job', { job_id: JOB1 })).data.state, 'stopped')
})

test('logs carry identifiers and sizes, never prompts, text or output', async () => {
  h = await setup()
  await h.link('link-a', 'tok_' + 'a'.repeat(40))
  await h.allow('link-a')
  await h.skill.command('link-a', 'start_job', start(JOB1, { prompt: 'PROMPT-SECRET-SENTINEL' }))
  await h.skill.command('link-a', 'send', { job_id: JOB1, text: 'TEXT-SECRET-SENTINEL', enter: true })
  h.agentEvent('term_1', 'waiting')
  await until(() => h.skill.events('link-a').length === 1)
  const logs = h.host.logs.join('\n')
  for (const s of ['PROMPT-SECRET', 'TEXT-SECRET', 'building', 'tok_aaaa']) assert.equal(logs.includes(s), false, s)
  assert.match(logs, /job\.status/)
})

test('send only when the agent waits or is done, and the CLI proves the terminal still runs that agent', async () => {
  h = await setup()
  await h.link('link-a', 'tok_' + 'a'.repeat(40))
  await h.allow('link-a')
  await h.skill.command('link-a', 'start_job', start(JOB1))
  const send = () => h.skill.command('link-a', 'send', { job_id: JOB1, text: 'go on', enter: true })
  const sends = () => h.execCalls.filter((c) => c.args[1] === 'send').length
  const live = (state: string) => (h.host.handlers['agents.list'] = () => ({ agents: [{ terminalId: 'term_1', state, title: 't', agent: 'claude', stateStartedAt: 1 }] }))

  for (const state of ['blocked', 'working']) {
    live(state)
    const r = await send()
    assert.equal(r.error.code, 'forbidden', state)
  }
  h.host.handlers['agents.list'] = () => ({ agents: [] })
  assert.equal((await send()).error.code, 'forbidden', 'no known state: not proven')
  assert.equal(sends(), 0)

  live('waiting')
  for (const bad of [
    { agentIdentity: null, connected: true, writable: true },
    { agentIdentity: 'bash', connected: true, writable: true },
    { agentIdentity: 'claude', connected: false, writable: true },
    { agentIdentity: 'claude', connected: true, writable: false }
  ]) {
    h.showReply = bad
    assert.equal((await send()).error.code, 'forbidden', JSON.stringify(bad))
  }
  assert.equal(sends(), 0, 'nothing was typed into the terminal')

  h.showReply = { agentIdentity: 'Claude', connected: true, writable: true }
  assert.deepEqual((await send()).data, { accepted: true })
  assert.equal(sends(), 1)
  live('done')
  assert.deepEqual((await send()).data, { accepted: true })
})

test('the same state with a different excerpt is a new event; the same excerpt is not', async () => {
  h = await setup()
  await h.link('link-a', 'tok_' + 'a'.repeat(40))
  await h.allow('link-a')
  await h.skill.command('link-a', 'start_job', start(JOB1))
  let lines = ['Which colour?', '1) red', '2) blue']
  h.host.handlers['terminal.read'] = () => ({ lines, truncated: false })
  h.agentEvent('term_1', 'waiting')
  await until(() => h.skill.events('link-a').length === 1)
  h.agentEvent('term_1', 'waiting') // same question again
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(h.skill.events('link-a').length, 1)
  lines = ['Which size?', '1) S', '2) L']
  h.agentEvent('term_1', 'waiting')
  await until(() => h.skill.events('link-a').length === 2)
  assert.match(h.skill.events('link-a')[1].event.excerpt, /Which size/)
  assert.equal(h.skill.events('link-a')[1].event.orca_state, 'waiting')
  h.agentEvent('term_1', 'blocked')
  await until(() => h.skill.events('link-a').length === 3)
  assert.equal(h.skill.events('link-a')[2].event.state, 'waiting_user')
  assert.equal(h.skill.events('link-a')[2].event.orca_state, 'blocked', 'the skill can tell a permission from a question')
})

test('start_job is persisted as in progress BEFORE workspace.create', async () => {
  h = await setup()
  await h.link('link-a', 'tok_' + 'a'.repeat(40))
  await h.allow('link-a')
  let seen: any = null
  h.host.handlers['workspace.create'] = async () => {
    await h.plugin.store.flush()
    seen = (h.host.store.get('jobs:link-a') as any)?.[JOB1]
    return { workspaceId: 'identity:wt2:local:ws-9', terminalId: 'term_9' }
  }
  await h.skill.command('link-a', 'start_job', start(JOB1))
  assert.equal(seen.phase, 'creating')
  await h.plugin.store.flush()
  assert.equal((h.host.store.get('jobs:link-a') as any)[JOB1].phase, 'running')
})
