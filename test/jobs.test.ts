import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { until } from './fake-skill.ts'
import { setup } from './harness.ts'
import type { Harness } from './harness.ts'
import * as F from './terminal-fixtures.ts'

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

test('a removed workspace emits job.gone', async () => {
  h = await setup()
  await h.link('link-a', 'tok_' + 'a'.repeat(40))
  await h.allow('link-a')
  await h.skill.command('link-a', 'start_job', start(JOB1))
  await h.skill.command('link-a', 'start_job', start(JOB2))
  h.workspaces.delete('identity:wt2:local:ws-1')
  await h.plugin.jobs.reconcile()
  await until(() => h.skill.events('link-a').some((e) => e.event.kind === 'job.gone'))
  const gone = h.skill.events('link-a').find((e) => e.event.kind === 'job.gone')
  assert.deepEqual(gone.event, { kind: 'job.gone', job_id: JOB1, reason: 'workspace_missing' })
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

test('send when the agent waits, is done or works, never on a permission, and the CLI proves the terminal still runs that agent', async () => {
  h = await setup()
  await h.link('link-a', 'tok_' + 'a'.repeat(40))
  await h.allow('link-a')
  await h.skill.command('link-a', 'start_job', start(JOB1))
  const send = () => h.skill.command('link-a', 'send', { job_id: JOB1, text: 'go on', enter: true })
  const sends = () => h.execCalls.filter((c) => c.args[1] === 'send').length
  const live = (state: string) => (h.host.handlers['agents.list'] = () => ({ agents: [{ terminalId: 'term_1', state, title: 't', agent: 'claude', stateStartedAt: 1 }] }))

  live('blocked')
  const blocked = await send()
  assert.equal(blocked.error.code, 'forbidden', 'blocked')
  assert.match(blocked.error.message, /permission/)
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

test('the same screen with other timers is not a second notice; a new answer is', async () => {
  h = await setup()
  await h.link('link-a', 'tok_' + 'a'.repeat(40))
  await h.allow('link-a')
  await h.skill.command('link-a', 'start_job', start(JOB1))
  let secs = 9
  h.host.handlers['terminal.read'] = () => ({ lines: F.claudeDone(secs), truncated: false })
  h.agentEvent('term_1', 'done', { mainAgent: { state: 'done', outcome: 'success' } })
  await until(() => h.skill.events('link-a').length === 1)
  assert.equal(h.skill.events('link-a')[0].event.excerpt, F.CLAUDE_DONE_ANSWER, 'only the answer, no banner or echo')
  secs = 131 // two minutes later: reconcile or a duplicate event, same screen but for the timer
  h.agentEvent('term_1', 'done', { mainAgent: { state: 'done', outcome: 'success' } })
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(h.skill.events('link-a').length, 1, 'no event without news')
  h.host.handlers['terminal.read'] = () => ({ lines: F.claudeQuestion(3), truncated: false })
  h.agentEvent('term_1', 'done', { mainAgent: { state: 'done', outcome: 'success' } })
  await until(() => h.skill.events('link-a').length === 2)
  assert.match(h.skill.events('link-a')[1].event.excerpt, /Which one do you prefer/)
})

test('send takes text or an option, exactly one; an option is a bare digit without Enter', async () => {
  h = await setup()
  await h.link('link-a', 'tok_' + 'a'.repeat(40))
  await h.allow('link-a')
  await h.skill.command('link-a', 'start_job', start(JOB1))
  h.agentEvent('term_1', 'waiting')
  await new Promise((r) => setTimeout(r, 150))
  const code = async (args: any) => (await h.skill.command('link-a', 'send', { job_id: JOB1, ...args })).error?.code
  assert.equal(await code({ text: 'a', enter: true, option: 2 }), 'invalid_args', 'both')
  assert.equal(await code({}), 'invalid_args', 'neither')
  for (const option of [0, 10, 1.5, '2', -1, null]) assert.equal(await code({ option }), 'invalid_args', String(option))
  assert.equal(await code({ option: 2, enter: true }), 'invalid_args')
  assert.equal(h.execCalls.filter((c) => c.args[1] === 'send').length, 0)
  // no selector on screen: nothing is typed
  const sendsNow = () => h.execCalls.filter((c) => c.args[1] === 'send').length
  const before = sendsNow()
  const none = await h.skill.command('link-a', 'send', { job_id: JOB1, option: 2 })
  assert.equal(none.error.code, 'invalid_args')
  assert.deepEqual(none.error.details, { options: [] })
  assert.equal(sendsNow(), before, 'nothing was typed')
  h.host.handlers['terminal.read'] = () => ({ lines: F.claudeSelectorDescriptions, truncated: false })
  assert.equal((await h.skill.command('link-a', 'send', { job_id: JOB1, option: 7 })).error.code, 'invalid_args', 'not among the 3 shown')
  const ok = await h.skill.command('link-a', 'send', { job_id: JOB1, option: 2 })
  assert.deepEqual(ok.data, { accepted: true })
  assert.deepEqual(h.execCalls.at(-1)!.args, ['terminal', 'send', '--terminal', 'term_1', '--text=2', '--json'])
  // same preconditions: never while blocked
  h.agentEvent('term_1', 'blocked')
  await new Promise((r) => setTimeout(r, 150))
  h.host.handlers['agents.list'] = () => ({ agents: [{ terminalId: 'term_1', state: 'blocked', title: 't', agent: 'claude', stateStartedAt: 1 }] })
  assert.equal(await code({ option: 1 }), 'forbidden')
})

test('a CLI that still says agent_prompt_blocked to an option is reported as forbidden', async () => {
  h = await setup()
  await h.link('link-a', 'tok_' + 'a'.repeat(40))
  await h.allow('link-a')
  await h.skill.command('link-a', 'start_job', start(JOB1))
  h.agentEvent('term_1', 'waiting')
  await new Promise((r) => setTimeout(r, 150))
  h.host.handlers['terminal.read'] = () => ({ lines: F.claudeSelectorSimple, truncated: false })
  h.sendFails = 'agent_prompt_blocked'
  assert.equal((await h.skill.command('link-a', 'send', { job_id: JOB1, option: 1 })).error.code, 'forbidden')
})

test('agent_prompt_blocked on text answers needs_option with the detected options, and is not retried', async () => {
  h = await setup()
  await h.link('link-a', 'tok_' + 'a'.repeat(40))
  await h.allow('link-a')
  await h.skill.command('link-a', 'start_job', start(JOB1))
  h.agentEvent('term_1', 'waiting')
  await new Promise((r) => setTimeout(r, 150))
  h.host.handlers['terminal.read'] = () => ({ lines: F.claudeSelectorSimple, truncated: false })
  h.sendFails = 'agent_prompt_blocked'
  const r = await h.skill.command('link-a', 'send', { job_id: JOB1, text: 'no', enter: true })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'needs_option')
  assert.match(r.error.message, /selector/)
  assert.deepEqual(r.error.details.options.map((o: any) => o.n), [1, 2, 3, 4])
  assert.equal(h.execCalls.filter((c) => c.args[1] === 'send').length, 1, 'one attempt, no splitting')
  h.host.handlers['terminal.read'] = () => ({ lines: ['nothing numbered'], truncated: false })
  const none = await h.skill.command('link-a', 'send', { job_id: JOB1, text: 'no', enter: true })
  assert.deepEqual(none.error.details, { options: [] })
  assert.equal(h.host.logs.some((l) => /send\.cli_error .*error_code=agent_prompt_blocked/.test(l)), true)
})

test('CLI failures map to contract codes with a useful message, never a mute internal', async () => {
  h = await setup()
  await h.link('link-a', 'tok_' + 'a'.repeat(40))
  await h.allow('link-a')
  await h.skill.command('link-a', 'start_job', start(JOB1))
  h.agentEvent('term_1', 'waiting')
  await new Promise((r) => setTimeout(r, 150))
  const expected: Record<string, string> = {
    terminal_not_found: 'not_found',
    not_writable: 'forbidden',
    runtime_unavailable: 'orca_unavailable',
    invalid_argument: 'invalid_args',
    some_new_code: 'internal'
  }
  for (const [cli, want] of Object.entries(expected)) {
    h.sendFails = cli
    const r = await h.skill.command('link-a', 'send', { job_id: JOB1, text: 'x', enter: true })
    assert.equal(r.error.code, want, cli)
    assert.ok(r.error.message.length > 10)
  }
})

test('waiting_user carries options; a change of options is news, the same options are not', async () => {
  h = await setup()
  await h.link('link-a', 'tok_' + 'a'.repeat(40))
  await h.allow('link-a')
  await h.skill.command('link-a', 'start_job', start(JOB1))
  let lines = F.claudeSelectorSimple
  h.host.handlers['terminal.read'] = () => ({ lines, truncated: false })
  h.agentEvent('term_1', 'waiting')
  await until(() => h.skill.events('link-a').length === 1)
  const ev = h.skill.events('link-a')[0].event
  assert.equal(ev.state, 'waiting_user')
  assert.deepEqual(ev.options.map((o: any) => o.label), ['Yes', 'No', 'Type something.', 'Chat about this'])
  assert.match(ev.excerpt, /staging config/)
  h.agentEvent('term_1', 'waiting')
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(h.skill.events('link-a').length, 1, 'same selector: no news')
  lines = F.claudeSelectorDescriptions
  h.agentEvent('term_1', 'waiting')
  await until(() => h.skill.events('link-a').length === 2)
  assert.equal(h.skill.events('link-a')[1].event.options.length, 3)
  lines = F.claudeQuestion(3)
  h.agentEvent('term_1', 'waiting')
  await until(() => h.skill.events('link-a').length === 3)
  assert.equal(h.skill.events('link-a')[2].event.options, undefined, 'no selector, no options')
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

// ---- restart / update of the worker (0.4.4) -------------------------------------------------------

const notOwned = () => Object.assign(new Error('not one of this plugin\'s terminals'), { code: 'action_failed' })
const kinds = () => h.skill.events('link-a').map((e) => e.event.kind + ':' + (e.event.state ?? e.event.reason))

async function twoJobsThenRestart() {
  h = await setup()
  await h.link('link-a', 'tok_' + 'a'.repeat(40))
  await h.allow('link-a')
  await h.skill.command('link-a', 'start_job', start(JOB1))
  await h.skill.command('link-a', 'start_job', start(JOB2))
  h.agentEvent('term_1', 'done', { mainAgent: { state: 'done', outcome: 'success' } })
  h.agentEvent('term_2', 'waiting')
  await until(() => ['idle', 'waiting_user'].every((st) => h.skill.events('link-a').some((e) => e.event.state === st)))
}

test('a restart with live terminals and workspaces emits nothing and keeps following the jobs', async () => {
  await twoJobsThenRestart()
  const before = h.skill.events('link-a').length
  h.host.handlers['agents.list'] = () => ({
    agents: [
      { terminalId: 'term_1', state: 'done', title: 't', agent: 'claude', stateStartedAt: 1 },
      { terminalId: 'term_2', state: 'working', title: 't', agent: 'claude', stateStartedAt: 1 }
    ]
  })
  await h.restart()
  await h.plugin.jobs.reconcile()
  await new Promise((r) => setTimeout(r, 250))
  assert.equal(h.plugin.jobs.activeCount(), 2)
  const events = h.skill.events('link-a').slice(before)
  assert.equal(events.some((e) => e.event.kind === 'job.gone' || e.event.state === 'stopped'), false, kinds().join(','))
  // job 2 moved while the worker was down: it is followed again (and reported), not closed
  assert.equal(events.at(-1)?.event.state, 'working')
  assert.equal(h.host.callsOf('terminal.close').length, 0)
})

test('a restart correlates by terminal id through agents.list when terminal.list does not show it', async () => {
  await twoJobsThenRestart()
  h.host.handlers['terminal.list'] = () => ({ terminals: [], truncated: false })
  h.host.handlers['agents.list'] = () => ({ agents: [{ terminalId: 'term_1', state: 'done', title: 't', agent: 'claude', stateStartedAt: 1 }] })
  await h.restart()
  await h.plugin.jobs.reconcile()
  assert.equal(h.plugin.store.jobsOf('link-a')[JOB1]!.phase, 'running')
  assert.equal(h.plugin.store.jobsOf('link-a')[JOB2]!.phase, 'stopped', 'terminal is nowhere: closed')
})

test('a restart marks gone only the job whose workspace vanished and stopped only the one whose terminal vanished', async () => {
  h = await setup()
  await h.link('link-a', 'tok_' + 'a'.repeat(40))
  await h.allow('link-a')
  for (const j of [JOB1, JOB2, JOB3]) await h.skill.command('link-a', 'start_job', start(j))
  h.workspaces.delete('identity:wt2:local:ws-1') // JOB1: workspace removed
  h.host.handlers['terminal.list'] = (p) =>
    String(p.workspaceId).endsWith('ws-2') ? { terminals: [], truncated: false } : { terminals: [{ id: 'term_3' }], truncated: false } // JOB2: terminal closed
  await h.restart()
  await h.plugin.jobs.reconcile()
  await until(() => h.skill.events('link-a').filter((e) => e.event.kind === 'job.gone' || e.event.state === 'stopped').length === 2)
  assert.deepEqual(kinds().filter((k) => /gone|stopped/.test(k)).sort(), ['job.gone:workspace_missing', 'job.status:stopped'])
  const jobs = h.plugin.store.jobsOf('link-a')
  assert.deepEqual([jobs[JOB1]!.phase, jobs[JOB2]!.phase, jobs[JOB3]!.phase], ['gone', 'stopped', 'running'])
})

test('reconcile never guesses: failed or truncated listings change nothing', async () => {
  await twoJobsThenRestart()
  const before = h.skill.events('link-a').length
  await h.restart()
  const run = async () => {
    await h.plugin.jobs.reconcile()
    assert.deepEqual(Object.values(h.plugin.store.jobsOf('link-a')).map((j) => j.phase), ['running', 'running'])
  }
  const list = h.host.handlers['workspace.list']!
  h.host.handlers['workspace.list'] = () => {
    throw notOwned()
  }
  await run()
  h.host.handlers['workspace.list'] = () => ({ workspaces: [], truncated: true })
  await run()
  h.host.handlers['workspace.list'] = list
  h.host.handlers['terminal.list'] = () => {
    throw notOwned()
  }
  await run()
  h.host.handlers['terminal.list'] = () => ({ terminals: [], truncated: true })
  await run()
  assert.equal(h.skill.events('link-a').length, before, 'no new events')
})

test('stop on a terminal the plugin no longer owns closes it through the CLI, and only that job\'s terminal', async () => {
  await twoJobsThenRestart()
  await h.restart()
  await until(() => (h as any).statusOf('link-a') === 'online', 3000, 'online again')
  h.host.handlers['terminal.close'] = () => {
    throw notOwned()
  }
  const r = await h.skill.command('link-a', 'stop', { job_id: JOB1 })
  assert.deepEqual(r.data, { stopped: true })
  const closes = h.execCalls.filter((c) => c.args[0] === 'terminal' && c.args[1] === 'close')
  assert.deepEqual(closes.map((c) => c.args), [['terminal', 'close', '--terminal', 'term_1', '--json']])
  await until(() => h.skill.events('link-a').some((e) => e.event.state === 'stopped'))
  assert.equal(h.plugin.store.jobsOf('link-a')[JOB2]!.phase, 'running', 'the other job is untouched')
})

test('stop whose terminal is already gone is a success without the CLI; with a live terminal and a failing CLI it is an error and the job stays running', async () => {
  await twoJobsThenRestart()
  h.host.handlers['terminal.close'] = () => {
    throw notOwned()
  }
  h.host.handlers['terminal.list'] = (p) => (String(p.workspaceId).endsWith('ws-1') ? { terminals: [], truncated: false } : { terminals: [{ id: 'term_2' }], truncated: false })
  assert.deepEqual((await h.skill.command('link-a', 'stop', { job_id: JOB1 })).data, { stopped: true })
  assert.equal(h.execCalls.filter((c) => c.args[1] === 'close').length, 0)

  h.closeFails = 'runtime_unavailable'
  const failed = await h.skill.command('link-a', 'stop', { job_id: JOB2 })
  assert.equal(failed.ok, false)
  assert.equal(failed.error.code, 'orca_unavailable')
  assert.equal(h.plugin.store.jobsOf('link-a')[JOB2]!.phase, 'running', 'never reported stopped while the terminal lives')
  assert.equal(h.skill.events('link-a').filter((e) => e.event.state === 'stopped').length, 1, 'only the real stop of JOB1')

  h.closeFails = 'weird_refusal'
  assert.equal((await h.skill.command('link-a', 'stop', { job_id: JOB2 })).ok, false)
  assert.equal(h.plugin.store.jobsOf('link-a')[JOB2]!.phase, 'running')
})

test('send while the agent works: typed after the same proofs; never on a permission, a selector or an unproven terminal (dev#2394)', async () => {
  h = await setup()
  await h.link('link-a', 'tok_' + 'a'.repeat(40))
  await h.allow('link-a')
  await h.skill.command('link-a', 'start_job', start(JOB1))
  const send = () => h.skill.command('link-a', 'send', { job_id: JOB1, text: 'use branch x', enter: true })
  const sends = () => h.execCalls.filter((c) => c.args[1] === 'send').length
  const live = (state: string) => (h.host.handlers['agents.list'] = () => ({ agents: [{ terminalId: 'term_1', state, title: 't', agent: 'claude', stateStartedAt: 1 }] }))
  h.showReply = { agentIdentity: 'Claude', connected: true, writable: true }

  // the foreground program cannot be proven to be the agent (a subprocess, a shell): nothing typed
  live('working')
  for (const bad of [
    { agentIdentity: null, connected: true, writable: true },
    { agentIdentity: 'bash', connected: true, writable: true },
    { agentIdentity: 'claude', connected: false, writable: true },
    { agentIdentity: 'claude', connected: true, writable: false }
  ]) {
    h.showReply = bad
    const r = await send()
    assert.equal(r.error.code, 'forbidden', JSON.stringify(bad))
    assert.match(r.error.message, /nothing was typed/)
  }
  assert.equal(sends(), 0)
  h.showReply = { agentIdentity: 'Claude', connected: true, writable: true }

  // a permission that appears while the terminal is being checked
  let calls = 0
  h.host.handlers['agents.list'] = () => ({ agents: [{ terminalId: 'term_1', state: ++calls === 1 ? 'working' : 'blocked', title: 't', agent: 'claude', stateStartedAt: 1 }] })
  assert.equal((await send()).error.code, 'forbidden', 'turned blocked during the send')
  assert.equal(sends(), 0)

  // a selector on screen takes only an option, never text
  live('working')
  h.host.handlers['terminal.read'] = () => ({ lines: F.claudeSelectorSimple, truncated: false })
  const sel = await send()
  assert.equal(sel.error.code, 'needs_option')
  assert.deepEqual(sel.error.details.options.map((o: any) => o.n), [1, 2, 3, 4])
  assert.equal(sends(), 0)
  h.host.handlers['terminal.read'] = () => ({ lines: ['building...'], truncated: false })

  // proven: typed, as in any other state
  assert.deepEqual((await send()).data, { accepted: true })
  assert.equal(sends(), 1)
  assert.deepEqual(h.execCalls.at(-1)!.args, ['terminal', 'send', '--terminal', 'term_1', '--text=use branch x', '--enter', '--json'])

  // no known state: not proven
  h.host.handlers['agents.list'] = () => ({ agents: [] })
  assert.equal((await send()).error.code, 'forbidden')
  assert.equal(sends(), 1)

  // an option is never typed mid-turn or after it: the selector there is most likely a permission not reported as blocked yet
  h.host.handlers['terminal.read'] = () => ({ lines: F.claudeSelectorSimple, truncated: false })
  for (const state of ['working', 'done']) {
    live(state)
    const r = await h.skill.command('link-a', 'send', { job_id: JOB1, option: 1 })
    assert.equal(r.error.code, 'forbidden', state)
    assert.match(r.error.message, /nothing was typed/)
  }
  assert.equal(sends(), 1)
  h.host.handlers['terminal.read'] = () => ({ lines: ['building...'], truncated: false })

  // only verified agents take a message mid-turn (contract §1): Codex steers, others are unverified
  await h.skill.command('link-a', 'start_job', start(JOB2, { agent: 'codex' }))
  h.host.handlers['agents.list'] = () => ({ agents: [{ terminalId: 'term_2', state: 'working', title: 't', agent: 'codex', stateStartedAt: 1 }] })
  h.showReply = { agentIdentity: 'codex', connected: true, writable: true }
  const codex = await h.skill.command('link-a', 'send', { job_id: JOB2, text: 'use branch x', enter: true })
  assert.equal(codex.error.code, 'forbidden')
  assert.match(codex.error.message, /not supported/)
  assert.equal(sends(), 1)
})
