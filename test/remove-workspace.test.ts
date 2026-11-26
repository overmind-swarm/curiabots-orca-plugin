import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { until } from './fake-skill.ts'
import { setup } from './harness.ts'
import type { Harness } from './harness.ts'

let h: Harness
afterEach(async () => h?.stop())

const JOB1 = '11111111-1111-4111-8111-111111111111'
const JOB2 = '22222222-2222-4222-8222-222222222222'
const start = (job_id: string) => ({
  job_id,
  project_id: 'p1',
  workspace_name: 'fix-2357',
  base_branch: 'main',
  agent: 'claude',
  prompt: 'Analyse issue 2357 and fix it'
})
const rmCalls = () => h.execCalls.filter((c) => c.args[0] === 'worktree' && c.args[1] === 'rm')
const showCalls = () => h.execCalls.filter((c) => c.args[0] === 'worktree' && c.args[1] === 'show')
const events = () => h.skill.events('link-a').map((e) => e.event)
const notOwned = () => Object.assign(new Error('not one of this plugin\'s terminals'), { code: 'action_failed' })

async function oneJob() {
  h = await setup()
  await h.link('link-a', 'tok_' + 'a'.repeat(40))
  await h.allow('link-a', ['p1'])
  await h.skill.command('link-a', 'start_job', start(JOB1))
}

test('removes only the job\'s own worktree through the CLI with an exact id, stops the agent and reports job.gone', async () => {
  await oneJob()
  const r = await h.skill.command('link-a', 'remove_workspace', { job_id: JOB1 })
  assert.deepEqual(r.data, { removed: true, branch_deleted: true, branch: 'curia/ws-1' })
  assert.deepEqual(showCalls().map((c) => c.args), [['worktree', 'show', '--worktree', 'identity:wt2:local:ws-1', '--json']])
  assert.deepEqual(rmCalls().map((c) => c.args), [['worktree', 'rm', '--worktree', 'id:repo-1::/wt/ws-1', '--delete-branch', '--json']])
  assert.deepEqual(h.host.callsOf('terminal.close').map((c) => c.params), [{ terminalId: 'term_1' }], 'the agent was stopped first')
  await until(() => events().some((e) => e.kind === 'job.gone'))
  const gone = events().filter((e) => e.kind === 'job.gone')
  assert.deepEqual(gone.map((e) => e.reason), ['removed_by_user'])
  assert.equal(events().some((e) => e.state === 'stopped'), false, 'no separate stopped notice when the removal succeeds')
  assert.equal(h.plugin.store.jobsOf('link-a')[JOB1]!.phase, 'gone')
  // Orca's own event for the removal does not produce a second, different job.gone
  h.plugin.onWorkspaceRemoved({ workspaceListId: 'identity:wt2:local:ws-1' })
  await new Promise((res) => setTimeout(res, 100))
  assert.equal(events().filter((e) => e.kind === 'job.gone').length, 1)
})

test('the CLI is run through the resolved path, without a shell and without ELECTRON_RUN_AS_NODE, never as a bare orca for rm', async () => {
  await oneJob()
  await h.skill.command('link-a', 'remove_workspace', { job_id: JOB1, force: true })
  const call = rmCalls()[0]!
  assert.notEqual(call.file, 'orca', 'the resolved CLI path, not the bare name')
  assert.deepEqual(call.args, ['worktree', 'rm', '--worktree', 'id:repo-1::/wt/ws-1', '--delete-branch', '--force', '--json'])
})

test('a job of another link is forbidden and nothing is run; an unknown job is not_found; bad args are invalid_args', async () => {
  await oneJob()
  await h.link('link-b', 'tok_' + 'b'.repeat(40))
  await h.allow('link-b', ['p2'])
  const foreign = await h.skill.command('link-b', 'remove_workspace', { job_id: JOB1 })
  assert.equal(foreign.error.code, 'forbidden')
  assert.equal((await h.skill.command('link-a', 'remove_workspace', { job_id: JOB2 })).error.code, 'not_found')
  for (const bad of [{}, { job_id: 'x' }, { job_id: JOB1, force: 'yes' }, { job_id: '__proto__' }]) {
    assert.equal((await h.skill.command('link-a', 'remove_workspace', bad)).error.code, 'invalid_args', JSON.stringify(bad))
  }
  assert.equal(rmCalls().length, 0)
  assert.equal(showCalls().length, 0)
  assert.equal(h.host.callsOf('terminal.close').length, 0, 'the foreign job\'s agent keeps running')
  assert.equal(h.plugin.store.jobsOf('link-a')[JOB1]!.phase, 'running')
})

test('arguments cannot name another worktree: extra path or workspace fields are ignored', async () => {
  await oneJob()
  await h.skill.command('link-a', 'start_job', start(JOB2))
  const r = await h.skill.command('link-a', 'remove_workspace', {
    job_id: JOB1,
    workspace_id: 'identity:wt2:local:ws-2',
    worktree: 'id:repo-1::/home/user/precious',
    path: '/home/user',
    force: false
  })
  assert.equal(r.ok, true)
  assert.deepEqual(rmCalls().map((c) => c.args[3]), ['id:repo-1::/wt/ws-1'], 'only the job\'s own worktree')
  assert.equal(h.plugin.store.jobsOf('link-a')[JOB2]!.phase, 'running', 'the other job is untouched')
})

test('never a worktree other than the job\'s: a CLI that resolves a different identity, or the main worktree, is forbidden', async () => {
  await oneJob()
  h.worktreeShow = () => ({ id: 'repo-1::/wt/other', identity: { key: 'wt2:local:other' }, isMainWorktree: false, branch: 'refs/heads/x' })
  let r = await h.skill.command('link-a', 'remove_workspace', { job_id: JOB1 })
  assert.equal(r.error.code, 'forbidden')
  assert.equal(rmCalls().length, 0)
  await h.skill.command('link-a', 'start_job', start(JOB2))
  h.worktreeShow = (sel) => ({ id: 'repo-1::/repo', identity: { key: sel.slice('identity:'.length) }, isMainWorktree: true, branch: 'refs/heads/main' })
  r = await h.skill.command('link-a', 'remove_workspace', { job_id: JOB2 })
  assert.equal(r.error.code, 'forbidden')
  assert.equal(rmCalls().length, 0)
  // the agent was stopped but the worktree stays: the skill is told the job stopped
  await until(() => events().filter((e) => e.state === 'stopped').length === 2)
})

test('uncommitted changes without force: has_changes, nothing deleted, the stopped agent is reported and the job is not gone', async () => {
  await oneJob()
  h.rmReply = {
    ok: false,
    error: { code: 'runtime_error', message: 'Failed to delete worktree at /wt/ws-1. M README.md\nA  new1.txt\n?? secret-notes.txt' }
  }
  const r = await h.skill.command('link-a', 'remove_workspace', { job_id: JOB1 })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'has_changes')
  assert.match(r.error.message, /3 files/)
  assert.equal(JSON.stringify(r).includes('secret-notes'), false, 'file names do not leave the computer')
  assert.equal(rmCalls()[0]!.args.includes('--force'), false)
  await until(() => events().some((e) => e.state === 'stopped'))
  assert.equal(events().some((e) => e.kind === 'job.gone'), false)
  assert.equal(h.plugin.store.jobsOf('link-a')[JOB1]!.phase, 'stopped')

  // retry with force succeeds, the worktree goes (the agent was already stopped: no second close)
  h.rmReply = { ok: true, result: { removed: true } }
  const forced = await h.skill.command('link-a', 'remove_workspace', { job_id: JOB1, force: true })
  assert.equal(forced.data.removed, true)
  assert.equal(rmCalls().at(-1)!.args.includes('--force'), true)
  assert.equal(h.host.callsOf('terminal.close').length, 1)
  await until(() => events().some((e) => e.kind === 'job.gone'))
  assert.equal(events().find((e) => e.kind === 'job.gone')!.reason, 'removed_by_user')
})

test('a branch Orca could not prove integrated is kept and the result says so; one it deleted says that', async () => {
  await oneJob()
  h.rmReply = { ok: true, result: { removed: true, preservedBranch: { branchName: 'curia/ws-1', head: 'abc' } } }
  const kept = await h.skill.command('link-a', 'remove_workspace', { job_id: JOB1 })
  assert.deepEqual(kept.data, { removed: true, branch_deleted: false, branch: 'curia/ws-1', branch_kept_reason: 'not_integrated' })
  await h.skill.command('link-a', 'start_job', start(JOB2))
  h.rmReply = { ok: true, result: { removed: true } }
  const deleted = await h.skill.command('link-a', 'remove_workspace', { job_id: JOB2 })
  assert.deepEqual(deleted.data, { removed: true, branch_deleted: true, branch: 'curia/ws-2' })
})

test('a worktree that no longer exists is an idempotent success (already_gone), from show or from rm', async () => {
  await oneJob()
  h.worktreeShow = () => null
  const r = await h.skill.command('link-a', 'remove_workspace', { job_id: JOB1 })
  assert.deepEqual(r.data, { removed: true, branch_deleted: false, already_gone: true })
  assert.equal(rmCalls().length, 0)
  await until(() => events().some((e) => e.kind === 'job.gone'))
  // again: the job is gone, still a success and no second event
  const again = await h.skill.command('link-a', 'remove_workspace', { job_id: JOB1 })
  assert.equal(again.data.already_gone, true)
  assert.equal(events().filter((e) => e.kind === 'job.gone').length, 1)

  await h.skill.command('link-a', 'start_job', start(JOB2))
  h.rmReply = { ok: false, error: { code: 'selector_not_found', message: 'selector_not_found' } }
  const viaRm = await h.skill.command('link-a', 'remove_workspace', { job_id: JOB2 })
  assert.equal(viaRm.data.already_gone, true)
})

test('a job whose start failed has no worktree: success without touching the CLI', async () => {
  h = await setup()
  await h.link('link-a', 'tok_' + 'a'.repeat(40))
  await h.allow('link-a', ['p1'])
  h.host.handlers['workspace.create'] = () => {
    throw Object.assign(new Error('boom'), { code: 'timeout' })
  }
  assert.equal((await h.skill.command('link-a', 'start_job', start(JOB1))).ok, false)
  const r = await h.skill.command('link-a', 'remove_workspace', { job_id: JOB1 })
  assert.equal(r.data.already_gone, true)
  assert.equal(showCalls().length + rmCalls().length, 0)
})

test('CLI failures map to useful errors and never a mute internal', async () => {
  await oneJob()
  const cases: [Harness['rmReply'], string][] = [
    [{ ok: false, error: { code: 'runtime_error', message: 'Failed to delete worktree at /wt/ws-1. fatal: cannot remove a locked working tree' } }, 'failed'],
    [{ ok: false, error: { code: 'runtime_unavailable', message: 'x' } }, 'orca_unavailable'],
    [{ ok: false, error: { code: 'something_new', message: 'brand new refusal' } }, 'failed']
  ]
  for (const [reply, code] of cases) {
    h.rmReply = reply
    const r = await h.skill.command('link-a', 'remove_workspace', { job_id: JOB1 })
    assert.equal(r.ok, false)
    assert.equal(r.error.code, code)
    assert.notEqual(r.error.code, 'internal')
    assert.ok(r.error.message.length > 10)
  }
  // a worktree that cannot be listed is not removed
  h.worktreeShow = () => {
    throw new Error('x')
  }
  assert.equal((await h.skill.command('link-a', 'remove_workspace', { job_id: JOB1 })).ok, false)
})

test('without a usable Orca CLI the answer is cli_unavailable and the worktree is untouched', async () => {
  await oneJob()
  const real = h.plugin.cli
  ;(real as any).exec = async () => {
    throw new Error('ENOENT')
  }
  ;(real as any).checkedAt = 0
  const r = await h.skill.command('link-a', 'remove_workspace', { job_id: JOB1 })
  assert.equal(r.error.code, 'cli_unavailable')
})

test('if the agent\'s terminal cannot be closed, nothing is removed and the job keeps running', async () => {
  await oneJob()
  h.host.handlers['terminal.close'] = () => {
    throw notOwned()
  }
  h.closeFails = 'runtime_unavailable'
  const r = await h.skill.command('link-a', 'remove_workspace', { job_id: JOB1 })
  assert.equal(r.ok, false)
  assert.equal(showCalls().length + rmCalls().length, 0)
  assert.equal(h.plugin.store.jobsOf('link-a')[JOB1]!.phase, 'running')
})

test('two removals of the same job at once: the second is told it is in progress, one rm runs', async () => {
  await oneJob()
  const [a, b] = await Promise.all([
    h.skill.command('link-a', 'remove_workspace', { job_id: JOB1 }),
    h.skill.command('link-a', 'remove_workspace', { job_id: JOB1 })
  ])
  assert.equal(rmCalls().length, 1)
  assert.deepEqual([a, b].map((x) => x.ok).sort(), [false, true])
  assert.equal([a, b].find((x) => !x.ok)!.error.code, 'in_progress')
})
