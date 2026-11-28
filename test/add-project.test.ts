// add_project (dev#2424): clone a Git repository into the user's clone folder and register it in Orca, only when the
// user allowed it on this computer, never outside that folder, never with a transport other than https or ssh.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { cloneArgs, gitEnv, originUrlOf, parseGitUrl, sameRemote } from '../src/addProject.ts'
import { repoFailure } from '../src/cli.ts'
import { validateArgs } from '../src/wire.ts'
import { until } from './fake-skill.ts'
import { setup } from './harness.ts'
import type { Harness } from './harness.ts'

let h: Harness | undefined
let root: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'curiabots-add-')))
})
afterEach(async () => {
  await h?.stop()
  h = undefined
  await rm(root, { recursive: true, force: true })
})

const URL = 'https://github.com/acme/widget.git'

/** git clone, faked: writes a repository whose origin is the URL into the folder git was given. */
async function fakeClone(args: string[]) {
  const dest = args[args.length - 1]!
  const url = args[args.length - 2]!
  await mkdir(join(dest, '.git'), { recursive: true })
  await writeFile(join(dest, '.git', 'config'), `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`)
  return { stdout: '', stderr: '' }
}

/** A linked link `link-a` with the switch on, the clone folder set and project.list knowing what repo add added. */
async function ready(opts: { allowAdd?: boolean; rootSetting?: string | null } = {}) {
  h = await setup()
  h.host.settingValues.cloneRoot = opts.rootSetting === undefined ? root : (opts.rootSetting ?? '')
  const added: { id: string; name: string; kind: string; hostId: string; path: string }[] = []
  const base = h.host.handlers['project.list']!
  h.host.handlers['project.list'] = async (p) => {
    const r = (await base(p)) as { projects: unknown[]; truncated: boolean }
    return { ...r, projects: [...r.projects, ...added] }
  }
  h.repoAddReply = (path) => {
    if (!added.some((a) => a.path === path)) added.push({ id: 'proj-' + (added.length + 1), name: path.split('/').pop()!, kind: 'git', hostId: 'local', path })
    const a = added.find((x) => x.path === path)!
    return { ok: true, result: { repo: { id: a.id, path, displayName: a.name, kind: 'git' } } }
  }
  h.git = fakeClone
  await h.link('link-a', 'tok_' + 'a'.repeat(40))
  if (opts.allowAdd !== false) await h.plugin.setAllowAddProjects('link-a', true)
  await until(() => h!.skill.connOf('link-a')?.hello && (h as any).statusOf('link-a') === 'online', 3000, 'online again')
  return h
}

const repoAdds = () => h!.execCalls.filter((c) => c.args[0] === 'repo' && c.args[1] === 'add')

test('URLs: only https and ssh, never credentials, local paths, file://, ext:: or an option', () => {
  for (const ok of [
    'https://github.com/acme/widget.git',
    'https://gitlab.example.com/group/sub/widget',
    'git@github.com:acme/widget.git',
    'ssh://git@github.com/acme/widget.git',
    'ssh://git@host.example:2222/acme/widget'
  ]) {
    assert.ok(parseGitUrl(ok), ok)
  }
  for (const bad of [
    'file:///etc/widget.git',
    '/home/user/widget',
    '../widget',
    'git://github.com/acme/widget.git',
    'http://github.com/acme/widget.git',
    'ext::sh -c touch% /tmp/pwned',
    'https://user:secret@github.com/acme/widget.git',
    'https://token@github.com/acme/widget.git',
    'ssh://-oProxyCommand=touch%20x/acme/widget',
    '-uhttps://github.com/acme/widget',
    'git@-oProxyCommand=x:acme/widget',
    '-oProxyCommand@host:acme/widget',
    'ssh://-oFoo@host/acme/widget',
    'https://github.com/acme/widget.git?x=1',
    'https://github.com/acme/widget.git#main',
    'https://github.com/acme/../widget',
    'https://github.com/',
    'https://github.com/acme/wid get',
    'https://github.com/acme/widget\n',
    'c:\\\\repos\\\\widget',
    '',
    'x'.repeat(600)
  ]) {
    assert.equal(parseGitUrl(bad), null, bad)
  }
  assert.equal(parseGitUrl('https://github.com/acme/widget.git')!.repoName, 'widget')
})

test('arguments: a directory is one folder name, never a path; anything else is invalid_args', () => {
  assert.deepEqual(validateArgs('add_project', { url: URL }), { ok: true, value: { url: URL } })
  assert.deepEqual(validateArgs('add_project', { url: URL, directory: 'my-widget' }), { ok: true, value: { url: URL, directory: 'my-widget' } })
  for (const directory of ['../x', 'a/b', '/abs', '.hidden', '..', '.', 'a\\b', '-rf', 'x'.repeat(101), 'x.lock', 7]) {
    assert.equal(validateArgs('add_project', { url: URL, directory }).ok, false, String(directory))
  }
  assert.equal(validateArgs('add_project', { url: 'file:///x/widget' }).ok, false)
  assert.equal(validateArgs('add_project', 'x').ok, false)
})

test('git runs with only https and ssh allowed, no submodules, no prompt, and -- before the URL', () => {
  const args = cloneArgs('https://h/a/b', '/root/.tmp')
  assert.deepEqual(args.slice(0, 8), ['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'protocol.ssh.allow=always', '-c', 'submodule.recurse=false'])
  assert.ok(args.includes('--no-recurse-submodules'))
  assert.deepEqual(args.slice(-3), ['--', 'https://h/a/b', '/root/.tmp'])
  const env = gitEnv({ PATH: '/bin', GIT_DIR: '/elsewhere', NODE_CHANNEL_FD: '3', ELECTRON_RUN_AS_NODE: '1' })
  assert.equal(env.GIT_TERMINAL_PROMPT, '0')
  assert.equal(env.GIT_PROTOCOL_FROM_USER, '0')
  assert.equal(env.GIT_DIR, undefined)
  assert.equal(env.NODE_CHANNEL_FD, undefined)
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined)
})

test('origin is read from .git/config as text, and remotes compare without .git and trailing slash', () => {
  assert.equal(originUrlOf('[remote "upstream"]\n\turl = a\n[remote "origin"]\n\turl = https://h/x.git\n'), 'https://h/x.git')
  assert.equal(originUrlOf('[core]\n'), null)
  assert.ok(sameRemote('https://h/x.git', 'https://h/x/'))
  assert.ok(!sameRemote('https://h/x.git', 'https://h/y.git'))
})

test('repo add errors map to the contract without local paths', () => {
  const e = repoFailure('runtime_error', 'Not a git repository: /home/me/secret/widget') as Error & { code?: string }
  assert.equal(e.code, 'failed')
  assert.ok(!e.message.includes('/home/me'), e.message)
  assert.equal((repoFailure('runtime_unavailable', '') as Error & { code?: string }).code, 'orca_unavailable')
})

test('hello announces project.add only with the switch on and a valid clone folder', async () => {
  await ready({ allowAdd: false })
  assert.ok(!h!.skill.connOf('link-a')!.hello.capabilities.includes('project.add'), 'off by default')
  await h!.plugin.setAllowAddProjects('link-a', true)
  await until(() => h!.skill.connOf('link-a')?.hello?.capabilities.includes('project.add'), 3000, 'announced after the switch')
  const state = await h!.plugin.getState()
  assert.equal(state.links[0]!.allow_add_projects, true)
  assert.deepEqual(state.clone_root, { configured: true, valid: true })
  assert.ok(!JSON.stringify(state).includes(root), 'the clone folder path is not in the panel state')
  // Without a usable folder nothing is announced, even with the switch on.
  h!.host.settingValues.cloneRoot = join(root, 'missing')
  await h!.plugin.setAllowAddProjects('link-a', false)
  await h!.plugin.setAllowAddProjects('link-a', true)
  await until(() => (h as any).statusOf('link-a') === 'online', 3000)
  assert.ok(!h!.skill.connOf('link-a')!.hello.capabilities.includes('project.add'))
  assert.deepEqual((await h!.plugin.getState()).clone_root, { configured: true, valid: false })
})

test('clones into the clone folder, registers it with the CLI and returns the project without allowing it', async () => {
  await ready()
  const r = await h!.skill.command('link-a', 'add_project', { url: URL }, 5000)
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.deepEqual(r.data, {
    project: { id: 'proj-1', name: 'widget', host_id: 'local' },
    directory: 'widget',
    cloned: true,
    already_registered: false,
    listed: true,
    allowed: false
  })
  assert.equal(h!.gitCalls.length, 1)
  const cloneTo = h!.gitCalls[0]!.at(-1)!
  assert.ok(cloneTo.startsWith(join(root, '.curiabots-clone-')), 'cloned into a temporary folder inside the root first')
  assert.deepEqual(repoAdds().map((c) => c.args), [['repo', 'add', '--path', join(root, 'widget'), '--kind', 'git', '--json']])
  assert.notEqual(repoAdds()[0]!.file, 'orca', 'the resolved CLI path')
  assert.deepEqual((await readdir(root)).sort(), ['widget'], 'no temporary folder left')
  assert.deepEqual(h!.plugin.store.link('link-a')!.allowed_projects, [], 'never allowed by default')
  assert.ok(!JSON.stringify(r).includes(root), 'no local path goes back to the service')
  // A start_job in the new project is still refused: the user has not allowed it.
  const start = await h!.skill.command('link-a', 'start_job', {
    job_id: '11111111-1111-4111-8111-111111111111', project_id: 'proj-1', workspace_name: 'x', agent: 'claude', prompt: 'hi'
  })
  assert.equal(start.error.code, 'forbidden')
})

test('with allow all projects the new project is allowed and announced', async () => {
  await ready()
  await h!.plugin.setAllowAll('link-a', true)
  const r = await h!.skill.command('link-a', 'add_project', { url: 'git@github.com:acme/gadget.git', directory: 'gadget-2' }, 5000)
  assert.equal(r.data.allowed, true)
  assert.equal(r.data.directory, 'gadget-2')
  await until(() => h!.skill.connOf('link-a')!.received.some((m: any) => m.type === 'projects' && m.projects.some((p: any) => p.id === 'proj-1')), 3000, 'projects announced')
})

test('repeating it is idempotent: the same repository already there is only registered again', async () => {
  await ready()
  await h!.skill.command('link-a', 'add_project', { url: URL }, 5000)
  const again = await h!.skill.command('link-a', 'add_project', { url: 'https://github.com/acme/widget' }, 5000)
  assert.equal(again.ok, true)
  assert.equal(again.data.cloned, false)
  assert.equal(again.data.already_registered, true)
  assert.equal(again.data.project.id, 'proj-1')
  assert.equal(h!.gitCalls.length, 1, 'not cloned twice')
})

test('another repository or a plain folder with that name is a conflict and nothing is touched', async () => {
  await ready()
  await mkdir(join(root, 'widget', '.git'), { recursive: true })
  await writeFile(join(root, 'widget', '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/other/widget.git\n')
  const r = await h!.skill.command('link-a', 'add_project', { url: URL }, 5000)
  assert.equal(r.error.code, 'conflict')
  await mkdir(join(root, 'plain'))
  assert.equal((await h!.skill.command('link-a', 'add_project', { url: URL, directory: 'plain' }, 5000)).error.code, 'conflict')
  assert.equal(h!.gitCalls.length, 0)
  assert.equal(repoAdds().length, 0)
})

test('a symbolic link at the destination is refused: nothing is written through links', async () => {
  await ready()
  const outside = await mkdtemp(join(tmpdir(), 'curiabots-outside-'))
  try {
    await symlink(outside, join(root, 'widget'))
    const r = await h!.skill.command('link-a', 'add_project', { url: URL }, 5000)
    assert.equal(r.error.code, 'forbidden')
    assert.equal(h!.gitCalls.length, 0)
    assert.deepEqual(await readdir(outside), [])
  } finally {
    await rm(outside, { recursive: true, force: true })
  }
})

test('a clone folder reached through a link is resolved, and the project path is the real one', async () => {
  await ready()
  const alias = join(await realpath(tmpdir()), `curiabots-alias-${process.pid}-${Date.now()}`)
  await symlink(root, alias)
  try {
    h!.host.settingValues.cloneRoot = alias
    const r = await h!.skill.command('link-a', 'add_project', { url: URL }, 5000)
    assert.equal(r.ok, true)
    assert.equal(repoAdds()[0]!.args[3], join(root, 'widget'))
  } finally {
    await rm(alias, { force: true })
  }
})

test('off for the link, no clone folder, or a relative one: forbidden, and nothing runs', async () => {
  await ready({ allowAdd: false })
  assert.equal((await h!.skill.command('link-a', 'add_project', { url: URL })).error.code, 'forbidden')
  await h!.plugin.setAllowAddProjects('link-a', true)
  await until(() => (h as any).statusOf('link-a') === 'online', 3000)
  for (const setting of ['', 'relative/dir', join(root, 'missing')]) {
    h!.host.settingValues.cloneRoot = setting
    const r = await h!.skill.command('link-a', 'add_project', { url: URL })
    assert.equal(r.error.code, 'forbidden', setting)
  }
  assert.equal(h!.gitCalls.length, 0)
  assert.equal(repoAdds().length, 0)
})

test('a clone that fails or times out leaves nothing behind and says why without local paths', async () => {
  await ready()
  h!.git = async (args) => {
    await mkdir(args.at(-1)!, { recursive: true })
    throw Object.assign(new Error('Command failed'), { stderr: `Cloning into '${args.at(-1)}'...\nfatal: repository 'https://github.com/acme/widget.git/' not found\n` })
  }
  const r = await h!.skill.command('link-a', 'add_project', { url: URL }, 5000)
  assert.equal(r.error.code, 'failed')
  assert.ok(r.error.message.includes('not found'))
  assert.ok(!r.error.message.includes(root))
  assert.deepEqual(await readdir(root), [])
  h!.git = async (args) => {
    await mkdir(args.at(-1)!, { recursive: true })
    throw Object.assign(new Error('killed'), { killed: true, signal: 'SIGKILL' })
  }
  assert.equal((await h!.skill.command('link-a', 'add_project', { url: URL }, 5000)).error.code, 'timeout')
  assert.deepEqual(await readdir(root), [])
  assert.equal(repoAdds().length, 0)
})

test('without the Orca CLI: cli_unavailable before cloning', async () => {
  await ready()
  ;(h!.plugin.cli as any).resolve = async () => null
  const r = await h!.skill.command('link-a', 'add_project', { url: URL })
  assert.equal(r.error.code, 'cli_unavailable')
  assert.equal(h!.gitCalls.length, 0)
})

test('the CLI refusing the project is reported and the clone is kept for a retry', async () => {
  await ready()
  h!.repoAddReply = () => ({ ok: false, error: { code: 'runtime_error', message: `Not a valid git repository: ${root}/widget` } })
  const r = await h!.skill.command('link-a', 'add_project', { url: URL }, 5000)
  assert.equal(r.error.code, 'failed')
  assert.ok(!r.error.message.includes(root))
  assert.deepEqual(await readdir(root), ['widget'])
})

test('one add at a time: a second one while cloning is in_progress', async () => {
  await ready()
  let release!: () => void
  h!.git = async (args) => {
    await new Promise<void>((res) => (release = res))
    return fakeClone(args)
  }
  const first = h!.skill.command('link-a', 'add_project', { url: URL }, 5000)
  await until(() => h!.gitCalls.length === 1, 3000)
  const second = await h!.skill.command('link-a', 'add_project', { url: 'https://github.com/acme/other.git' }, 5000)
  assert.equal(second.error.code, 'in_progress')
  release()
  assert.equal((await first).ok, true)
})

test('logs never carry the URL or the clone folder', async () => {
  await ready()
  await h!.skill.command('link-a', 'add_project', { url: URL }, 5000)
  const logs = h!.host.logs.join('\n')
  assert.ok(logs.includes('add_project.done'))
  assert.ok(!logs.includes('acme'), 'no URL in the log')
  assert.ok(!logs.includes(root), 'no local path in the log')
})
