import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { until } from './fake-skill.ts'
import { setup } from './harness.ts'
import type { Harness } from './harness.ts'

let h: Harness
afterEach(async () => h?.stop())

const TOKEN = 'tok_' + 'a'.repeat(40)
const JOB1 = '11111111-1111-4111-8111-111111111111'
const JOB2 = '22222222-2222-4222-8222-222222222222'
const start = (job_id: string, extra: Record<string, unknown> = {}) => ({
  job_id,
  project_id: 'p1',
  workspace_name: 'fix-1',
  agent: 'claude',
  prompt: 'go',
  ...extra
})
const projectsMsgs = (link: string) => h.skill.connOf(link)!.received.filter((m) => m.type === 'projects')
const ids = (m: any) => (m?.projects ?? []).map((p: any) => `${p.host_id}:${p.id}`)

/** Orca's project list, mutable so a test can add, hide or break it. */
function orcaProjects() {
  const state = {
    fail: false,
    list: [
      { id: 'p1', name: 'Repo One', kind: 'git', hostId: 'local', path: '/work/one' },
      { id: 'p2', name: 'Repo Two', kind: 'git', hostId: 'local', path: '/work/two' },
      { id: 'p3', name: 'Remote', kind: 'git', hostId: 'ssh:box', path: '/srv/r' },
      { id: 'f1', name: 'Folder', kind: 'folder', hostId: 'local', path: '/f' },
      { id: 'h1', name: 'Hidden', kind: 'git', hostId: 'local', path: '/h', hidden: true }
    ] as any[]
  }
  h.host.handlers['project.list'] = () => {
    if (state.fail) throw Object.assign(new Error('busy'), { code: 'unavailable' })
    return { projects: state.list, truncated: false }
  }
  return state
}

test('off by default: hello and start_job follow the explicit list only', async () => {
  h = await setup()
  await h.link('link-a', TOKEN)
  assert.equal(h.plugin.store.link('link-a')!.allow_all_projects, undefined)
  assert.equal((await h.plugin.getState()).links[0]!.allow_all_projects, false)
  assert.deepEqual(h.skill.connOf('link-a')!.hello.projects, [])
  await h.allow('link-a', ['p1'])
  assert.equal((await h.skill.command('link-a', 'start_job', start(JOB1, { project_id: 'p2' }))).error.code, 'forbidden')
  assert.equal((await h.skill.command('link-a', 'start_job', start(JOB1))).ok, true)
})

test('on: hello and projects carry every git project of project.list, not folders or hidden ones', async () => {
  h = await setup()
  await h.link('link-a', TOKEN)
  orcaProjects()
  assert.equal(await h.plugin.setAllowAll('link-a', true), true)
  await until(() => projectsMsgs('link-a').length >= 1, 3000, 'projects message')
  assert.deepEqual(ids(projectsMsgs('link-a').at(-1)), ['local:p1', 'local:p2', 'ssh:box:p3'])
  assert.equal((await h.plugin.getState()).links[0]!.allow_all_projects, true)

  // and the flag survives a restart: the new hello carries them
  const before = h.skill.conns.length
  await h.restart()
  await until(() => h.skill.conns.length > before && !!h.skill.conns.at(-1)!.hello, 3000, 'hello after restart')
  assert.deepEqual(ids(h.skill.conns.at(-1)!.hello), ['local:p1', 'local:p2', 'ssh:box:p3'])
})

test('on: start_job accepts any listed project, and nothing Orca does not list', async () => {
  h = await setup()
  await h.link('link-a', TOKEN)
  const orca = orcaProjects()
  await h.plugin.setAllowAll('link-a', true)
  const r = await h.skill.command('link-a', 'start_job', start(JOB1, { project_id: 'p3', host_id: 'ssh:box' }))
  assert.equal(r.ok, true)
  assert.equal(h.host.callsOf('workspace.create')[0]!.params.hostId, 'ssh:box')
  for (const bad of [
    start(JOB2, { project_id: 'f1' }), // a folder
    start(JOB2, { project_id: 'h1' }), // hidden
    start(JOB2, { project_id: '/etc' }), // a path, not a project
    start(JOB2, { project_id: 'p1', host_id: 'ssh:box' }), // right id, wrong host
    start(JOB2, { project_id: 'nope' })
  ]) {
    assert.equal((await h.skill.command('link-a', 'start_job', bad)).error.code, 'forbidden', JSON.stringify(bad))
  }
  assert.equal(h.host.callsOf('workspace.create').length, 1)
  orca.fail = true
  assert.equal((await h.skill.command('link-a', 'start_job', start(JOB2))).error.code, 'orca_unavailable', 'no listing, no job')
  assert.equal(h.host.callsOf('workspace.create').length, 1)
})

test('a project added after turning it on is announced on the next refresh and can be started at once', async () => {
  h = await setup()
  await h.link('link-a', TOKEN)
  const orca = orcaProjects()
  await h.plugin.setAllowAll('link-a', true)
  await until(() => projectsMsgs('link-a').length >= 1)
  await h.plugin.refreshAllProjects()
  assert.equal(projectsMsgs('link-a').length, 1, 'nothing changed: nothing sent')

  orca.list.push({ id: 'p9', name: 'New', kind: 'git', hostId: 'local', path: '/work/new' })
  // even before the announcement, start_job reads the live list
  assert.equal((await h.skill.command('link-a', 'start_job', start(JOB1, { project_id: 'p9' }))).ok, true)
  h.plugin.onWorkspaceCreated()
  await until(() => projectsMsgs('link-a').length === 2, 3000, 'refresh after workspace.created')
  assert.deepEqual(ids(projectsMsgs('link-a').at(-1)), ['local:p1', 'local:p2', 'ssh:box:p3', 'local:p9'])

  // a removed project goes the same way
  orca.list = orca.list.filter((p) => p.id !== 'p2')
  await h.plugin.refreshAllProjects()
  await until(() => projectsMsgs('link-a').length === 3)
  assert.deepEqual(ids(projectsMsgs('link-a').at(-1)), ['local:p1', 'ssh:box:p3', 'local:p9'])

  // a failing listing keeps what the link was told
  orca.fail = true
  await h.plugin.refreshAllProjects()
  assert.equal(projectsMsgs('link-a').length, 3)
})

test('the periodic refresh finds a project added without any event', async () => {
  h = await setup({ timing: { projectsPollMs: 60 } })
  await h.link('link-a', TOKEN)
  const orca = orcaProjects()
  await h.plugin.setAllowAll('link-a', true)
  await until(() => projectsMsgs('link-a').length >= 1)
  orca.list.push({ id: 'p7', name: 'Later', kind: 'git', hostId: 'local', path: '/later' })
  await until(() => ids(projectsMsgs('link-a').at(-1)).includes('local:p7'), 3000, 'poll')
})

test('turning it off goes back to the explicit list, which was kept', async () => {
  h = await setup()
  await h.link('link-a', TOKEN)
  orcaProjects()
  await h.allow('link-a', ['p1'])
  await h.plugin.setAllowAll('link-a', true)
  await until(() => ids(projectsMsgs('link-a').at(-1)).length === 3)
  await h.plugin.setAllowAll('link-a', false)
  await until(() => ids(projectsMsgs('link-a').at(-1)).length === 1)
  assert.deepEqual(ids(projectsMsgs('link-a').at(-1)), ['local:p1'])
  assert.equal((await h.skill.command('link-a', 'start_job', start(JOB1, { project_id: 'p2' }))).error.code, 'forbidden')
  assert.equal((await h.skill.command('link-a', 'start_job', start(JOB1))).ok, true)
})

test('a link saved by 0.1.x (no flag) loads as off; the flag is per link', async () => {
  h = await setup()
  await h.link('link-a', TOKEN)
  await h.link('link-b', 'tok_' + 'b'.repeat(40))
  await h.allow('link-a', ['p1'])
  const links = JSON.parse(JSON.stringify(h.host.store.get('links'))) as any[]
  for (const l of links) delete l.allow_all_projects
  h.host.store.set('links', links)
  const hellos = h.skill.conns.length
  await h.restart()
  await until(() => h.skill.conns.length >= hellos + 2 && h.skill.conns.slice(-2).every((c) => !!c.hello), 3000, 'both links back')
  assert.deepEqual(h.plugin.store.links.map((l) => l.allow_all_projects), [false, false])
  assert.equal(h.plugin.store.link('link-a')!.allowed_projects.length, 1)
  await h.plugin.setAllowAll('link-a', true)
  assert.equal(h.plugin.store.link('link-b')!.allow_all_projects, false)
  assert.equal((await h.skill.command('link-b', 'start_job', start(JOB1))).error.code, 'forbidden')
})

test('a revoked or unknown link cannot be switched', async () => {
  h = await setup()
  await h.link('link-a', TOKEN)
  assert.equal(await h.plugin.setAllowAll('nope', true), false)
  h.plugin.store.link('link-a')!.revoked = true
  assert.equal(await h.plugin.setAllowAll('link-a', true), false)
})

test('welcome can rename the link; without the fields nothing is overwritten', async () => {
  h = await setup()
  h.skill.welcomeExtra = { bot_label: 'Marvin', link_name: 'Portatil de Sergio' }
  await h.link('link-a', TOKEN)
  await until(() => h.plugin.store.link('link-a')!.bot_label === 'Marvin', 3000, 'bot_label from welcome')
  assert.equal(h.plugin.store.link('link-a')!.link_name, 'Portatil de Sergio')
  const view = (await h.plugin.getState()).links[0]!
  assert.equal(view.bot_label, 'Marvin')
  assert.equal(view.link_name, 'Portatil de Sergio')

  h.skill.welcomeExtra = { bot_label: undefined }
  const before = h.skill.conns.length
  await h.restart()
  await until(() => h.skill.conns.length > before && !!h.skill.conns.at(-1)!.hello, 3000)
  await until(() => h.skill.conns.length > before, 3000)
  assert.equal(h.plugin.store.link('link-a')!.bot_label, 'Marvin')
})
