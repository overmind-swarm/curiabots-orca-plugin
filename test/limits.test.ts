// The user's cap of simultaneous jobs (dev#2393): the plugin obeys the skill's number (0 = no limit), takes a
// change without reconnecting, and does not count the jobs the skill has archived.
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { setup } from './harness.ts'
import type { Harness } from './harness.ts'

let h: Harness
afterEach(async () => h?.stop())

const id = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`
const start = (job_id: string) => ({ job_id, project_id: 'p1', workspace_name: 'fix-' + job_id.slice(0, 4), base_branch: 'main', agent: 'claude', prompt: 'Analyse and fix it' })

async function linked(limits: Record<string, number>) {
  h = await setup()
  h.skill.welcomeLimits = limits
  await h.link('link-a', 'tok_' + 'a'.repeat(40))
  await h.allow('link-a', ['p1'])
}
const run = (n: number) => h.skill.command('link-a', 'start_job', start(id(n)))
const send = (msg: Record<string, unknown>) => h.skill.send(h.skill.connOf('link-a')!, { v: 1, ...msg })
const outcomes = async (from: number, count: number) => {
  const out: string[] = []
  for (let i = from; i < from + count; i++) {
    const r = await run(i)
    out.push(r.ok ? 'ok' : r.error.code)
  }
  return out
}

test('a cap above 5 is obeyed: the plugin no longer clamps what the skill announces', async () => {
  await linked({ max_jobs: 8, max_prompt_bytes: 16384 })
  assert.deepEqual(await outcomes(1, 9), [...Array(8).fill('ok'), 'limit_reached'])
})

test('0 is no limit: nothing is refused, and there is no fixed total across links either', async () => {
  await linked({ max_jobs: 0, max_prompt_bytes: 16384 })
  assert.deepEqual(await outcomes(1, 14), Array(14).fill('ok'))
})

test('a skill that announces no cap leaves the historical default of 5', async () => {
  await linked({ max_prompt_bytes: 16384 })
  assert.deepEqual(await outcomes(1, 6), [...Array(5).fill('ok'), 'limit_reached'])
})

test('a `limits` message changes the cap with no reconnect: raise, lower below the running jobs (they go on), and 0', async () => {
  await linked({ max_jobs: 2, max_prompt_bytes: 16384 })
  const sockets = h.skill.conns.length
  assert.deepEqual(await outcomes(1, 3), ['ok', 'ok', 'limit_reached'])
  send({ type: 'limits', limits: { max_jobs: 4, max_prompt_bytes: 16384 } })
  assert.deepEqual(await outcomes(3, 3), ['ok', 'ok', 'limit_reached'], 'raised to 4: two more fit')
  send({ type: 'limits', limits: { max_jobs: 1, max_prompt_bytes: 16384 } })
  assert.deepEqual(await outcomes(10, 1), ['limit_reached'], 'lowered below the four running: only new ones are refused')
  const get = await h.skill.command('link-a', 'get_job', { job_id: id(1) })
  assert.equal(get.ok, true, 'a running job is untouched by the lower cap')
  send({ type: 'limits', limits: { max_jobs: 0, max_prompt_bytes: 16384 } })
  assert.deepEqual(await outcomes(20, 8), Array(8).fill('ok'))
  assert.equal(h.skill.conns.length, sockets, 'no reconnect')
})

test('a `limits` message with nothing usable falls back to the default, never to a stricter or looser surprise', async () => {
  await linked({ max_jobs: 0, max_prompt_bytes: 16384 })
  send({ type: 'limits', limits: { max_jobs: -3 } })
  assert.deepEqual(await outcomes(1, 6), [...Array(5).fill('ok'), 'limit_reached'], 'the invalid value is dropped: the default 5')
})

test('jobs the skill archived do not occupy a slot; restoring one takes it back', async () => {
  await linked({ max_jobs: 2, max_prompt_bytes: 16384 })
  assert.deepEqual(await outcomes(1, 3), ['ok', 'ok', 'limit_reached'])
  send({ type: 'archived', job_ids: [id(1)] })
  assert.deepEqual(await outcomes(3, 1), ['ok'], 'the archived job freed its slot')
  assert.deepEqual(await outcomes(4, 1), ['limit_reached'])
  // The message is always the complete set: an empty one is the restore of everything.
  send({ type: 'archived', job_ids: [] })
  assert.deepEqual(await outcomes(5, 1), ['limit_reached'])
  // An archived job still runs in Orca: it answers commands as any other.
  send({ type: 'archived', job_ids: [id(1), id(2)] })
  assert.equal((await h.skill.command('link-a', 'get_job', { job_id: id(1) })).ok, true)
  // Running now: job 3 only (jobs 1 and 2 are archived), so one slot is free.
  assert.deepEqual(await outcomes(6, 2), ['ok', 'limit_reached'])
})

test('archived ids are per link and ignored for ids that are not jobs of this plugin', async () => {
  await linked({ max_jobs: 1, max_prompt_bytes: 16384 })
  assert.deepEqual(await outcomes(1, 1), ['ok'])
  send({ type: 'archived', job_ids: [id(99), '__proto__', 'constructor', 5, null] })
  assert.deepEqual(await outcomes(2, 1), ['limit_reached'], 'a made-up id frees nothing')
})
