import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { OrcaCli, candidatePaths, defaultExec, parseStatus } from '../src/cli.ts'
import { resolveEndpoints } from '../src/endpoints.ts'
import { PLUGIN_VERSION } from '../src/version.ts'
import { backoffDelay, boundLines, truncateTailBytes } from '../src/util.ts'
import { buildExcerpt } from '../src/excerpt.ts'
import { mapState, parseServerMessage, validateArgs } from '../src/wire.ts'

test('backoff doubles from 1 s to a 5 min cap and always keeps a jitter floor', () => {
  assert.equal(backoffDelay(0, () => 0), 500)
  assert.equal(backoffDelay(0, () => 1), 1000)
  assert.equal(backoffDelay(3, () => 1), 8000)
  assert.equal(backoffDelay(50, () => 1), 300_000)
  assert.equal(backoffDelay(50, () => 0), 150_000)
  for (let i = 0; i < 100; i++) {
    const d = backoffDelay(4)
    assert.ok(d >= 8000 && d <= 16_000)
  }
})

test('excerpt: at most 40 lines and 4 KiB keeping the end, control sequences removed', () => {
  const lines = Array.from({ length: 100 }, (_, i) => (i % 2 ? '' : `\u001b[1mline ${i}\u001b[0m`))
  const ex = buildExcerpt(lines)
  assert.equal(ex.split('\n').length, 40)
  assert.ok(ex.endsWith('line 98'))
  assert.equal(ex.includes('\u001b'), false)
  const big = buildExcerpt(['é'.repeat(5000)])
  assert.ok(Buffer.byteLength(big) <= 4096)
  assert.equal(truncateTailBytes('abc', 10), 'abc')
  assert.equal(buildExcerpt(['answer', '─'.repeat(80), '❯', '─'.repeat(80)]), 'answer', 'frame rules and the empty prompt are dropped, content kept')
})

test('read_output lines are bounded in size and keep the newest', () => {
  const out = boundLines(Array.from({ length: 1000 }, (_, i) => 'x'.repeat(1000) + i), 10_000)
  assert.equal(out.truncated, true)
  assert.ok(out.lines.at(-1)!.endsWith('999'))
  assert.ok(out.lines.length < 20)
  assert.equal(boundLines(['y'.repeat(5000)]).lines[0]!.length, 2000)
})

test('state mapping follows the contract', () => {
  assert.equal(mapState('working'), 'working')
  assert.equal(mapState('waiting'), 'waiting_user')
  assert.equal(mapState('blocked'), 'waiting_user')
  assert.equal(mapState('done'), 'idle')
  assert.equal(mapState('done', 'success'), 'idle')
  assert.equal(mapState('done', 'cancellation'), 'idle')
  assert.equal(mapState('done', 'failure'), 'failed')
})

test('server messages are validated', () => {
  const ok = parseServerMessage(JSON.stringify({ v: 1, type: 'welcome', link_id: 'l-1', bot_label: 'Bot\n', limits: { max_jobs: 3, max_prompt_bytes: 99999999 } }))
  assert.deepEqual(ok, { type: 'welcome', link_id: 'l-1', bot_label: 'Bot', limits: { max_jobs: 3, max_prompt_bytes: 16384 } })
  const named = parseServerMessage(JSON.stringify({ v: 1, type: 'welcome', link_id: 'l-1', bot_label: 'Bot', link_name: ' Mi Orca\n', limits: {} }))
  assert.deepEqual(named, { type: 'welcome', link_id: 'l-1', bot_label: 'Bot', link_name: 'Mi Orca', limits: {} })
  const bare = parseServerMessage(JSON.stringify({ v: 1, type: 'welcome', link_id: 'l-1', limits: {} }))
  assert.deepEqual(bare, { type: 'welcome', link_id: 'l-1', limits: {} }, 'no label sent: nothing to overwrite with')
  for (const bad of [
    'x', '[]', '{"v":2,"type":"ping"}', '{"v":1}', '{"v":1,"type":"nope"}',
    '{"v":1,"type":"welcome","link_id":"../x"}',
    '{"v":1,"type":"command","id":"a b","name":"stop"}',
    '{"v":1,"type":"ack","seq":"1"}',
    JSON.stringify({ v: 1, type: 'command', id: 'a', name: 'x'.repeat(300_000) })
  ]) assert.equal(parseServerMessage(bad), null, bad.slice(0, 40))
  assert.equal(parseServerMessage(Buffer.from('{}')), null)
  assert.deepEqual(parseServerMessage('{"v":1,"type":"ping","extra":1}'), { type: 'ping' })
})

test('command arguments: only the documented shapes get through', () => {
  const j = '11111111-1111-4111-8111-111111111111'
  assert.deepEqual(validateArgs('get_job', { job_id: j, evil: 1 }), { ok: true, value: { job_id: j } })
  assert.equal(validateArgs('read_output', { job_id: j, tail_lines: 0 }).ok, false)
  assert.equal(validateArgs('read_output', { job_id: j, tail_lines: 1.5 }).ok, false)
  assert.equal(validateArgs('send', { job_id: j, text: 'a\u0000b', enter: true }).ok, false)
  assert.equal(validateArgs('send', { job_id: j, text: 'x'.repeat(17000), enter: true }).ok, false)
  assert.equal(validateArgs('get_job', { job_id: '__proto__' }).ok, false)
  assert.equal(validateArgs('stop', null).ok, false)
  const s = validateArgs('start_job', { job_id: j, project_id: 'p', workspace_name: 'n', agent: 'codex', prompt: 'x'.repeat(100) }, 50)
  assert.equal(s.ok, false, 'the link limit on prompt size applies')
})

test('service URL: https, or http only on loopback; no credentials, query or fragment', () => {
  assert.equal(resolveEndpoints(undefined)!.pairUrl, 'https://api.curiabots.com/skills/orca/connector/pair')
  assert.equal(resolveEndpoints('')!.wsUrl, 'wss://api.curiabots.com/skills/orca/connector')
  assert.equal(resolveEndpoints('http://127.0.0.1:8080/x/')!.wsUrl, 'ws://127.0.0.1:8080/x/connector')
  for (const bad of ['http://example.com', 'ftp://x', 'https://u:p@x.com', 'https://x.com/?a=1', 'https://x.com/#f', 'nonsense', 'http://localhost.evil.com']) {
    assert.equal(resolveEndpoints(bad), null, bad)
  }
})

test('CLI resolution order and the status probe', async () => {
  assert.deepEqual(candidatePaths('/opt/orca', 'linux').slice(0, 1), ['/opt/orca'])
  assert.equal(candidatePaths('relative/orca', 'linux').includes('relative/orca'), false, 'only absolute paths from settings')
  assert.equal(candidatePaths(undefined, 'linux').at(-1), 'orca')
  assert.ok(candidatePaths(undefined, 'linux')[0]!.endsWith('/linux-orca-cli-shim/orca'))
  assert.equal(candidatePaths(undefined, 'darwin').length, 1)
  assert.deepEqual(parseStatus('{"ok":true,"result":{"runtime":{"appVersion":"1.4.267"}}}'), { ok: true, orcaVersion: '1.4.267' })
  assert.equal(parseStatus('{"ok":true,"result":{}}').ok, false)
  assert.equal(parseStatus('Orca screen reader').ok, false)

  const tried: string[] = []
  const cli = new OrcaCli(
    async () => undefined,
    async (file, args) => {
      tried.push(file)
      if (file.endsWith('linux-orca-cli-shim/orca')) return { stdout: '{"ok":true,"result":{"runtime":{}}}', stderr: '' }
      if (file === 'orca') return { stdout: 'screen reader noise', stderr: '' }
      throw new Error('missing ' + args.join(' '))
    },
    Date.now,
    'linux'
  )
  assert.equal((await cli.resolve())!.path.endsWith('linux-orca-cli-shim/orca'), true)
  assert.equal(tried.length, 1)
})

test('the CLI runs without a shell and without ELECTRON_RUN_AS_NODE', async () => {
  process.env.ELECTRON_RUN_AS_NODE = '1'
  try {
    const { stdout } = await defaultExec(process.execPath, ['-e', 'console.log(String(process.env.ELECTRON_RUN_AS_NODE))'], 5000)
    assert.equal(stdout.trim(), 'undefined')
    // no shell: metacharacters stay literal arguments
    const out = await defaultExec(process.execPath, ['-e', 'console.log(process.argv[1])', '$(echo pwned); `id` | cat'], 5000)
    assert.equal(out.stdout.trim(), '$(echo pwned); `id` | cat')
  } finally {
    delete process.env.ELECTRON_RUN_AS_NODE
  }
})

test('send rejects odd terminal ids before running anything', async () => {
  let ran = 0
  const cli = new OrcaCli(async () => undefined, async () => (ran++, { stdout: '{"ok":true,"result":{"runtime":{}}}', stderr: '' }))
  await assert.rejects(() => cli.send('--evil', 'x', false), { code: 'internal' })
  await assert.rejects(() => cli.send('a b', 'x', false), { code: 'internal' })
  assert.equal(ran, 0)
})

test('PLUGIN_VERSION matches the manifest and the manifest asks for no more than the contract allows', () => {
  const manifest = JSON.parse(readFileSync(new URL('../orca-plugin.json', import.meta.url), 'utf8'))
  assert.equal(manifest.version, PLUGIN_VERSION)
  assert.equal(manifest.id, 'curiabots')
  assert.equal(manifest.license, 'MIT')
  assert.equal(manifest.execution, 'trusted-worker')
  assert.deepEqual(manifest.capabilities.map((c: any) => c.kind).sort(), [
    'agent:launch', 'agent:read', 'secrets:own', 'settings:own', 'storage:own', 'terminal:read', 'terminal:send',
    'workspace:create', 'workspace:read'
  ])
  assert.equal(manifest.contributes.statusBarItems.length, 1)
  const settings = Object.fromEntries(manifest.contributes.settings.map((s: any) => [s.key, s]))
  assert.equal(settings.allowTokenWithoutKeyring.default, false)
  assert.equal(settings.serviceUrl.default, 'https://api.curiabots.com/skills/orca')
  // 1.4.274: the panel icon may be an inline SVG path (our robot), drawn in the theme color.
  assert.match(manifest.engines.orca, /^>=1\.4\.274$/)
  const icon = manifest.contributes.panels[0].icon
  assert.equal(typeof icon, 'object')
  assert.match(icon.path, /^M[MmLlHhVvCcSsQqTtAaZz0-9 ,.+\-eE]*$/)
  assert.ok(icon.path.length <= 4096)
  assert.equal(icon.mode, 'stroke')
  assert.equal(manifest.cover.path, 'assets/cover.jpg')
  assert.ok(manifest.cover.alt.length > 0)
})

test('object-key names are never valid job ids', () => {
  for (const id of ['__proto__', 'constructor', 'prototype', 'hasOwnProperty'])
    assert.equal(validateArgs('get_job', { job_id: id }).ok, false, id)
})

test('worktree CLI errors map to the contract without leaking file names or going mute', async () => {
  const { worktreeFailure } = await import('../src/cli.ts')
  const code = (cliCode: string | null, message: string) => (worktreeFailure(cliCode, message) as any).code
  const dirty = 'Failed to delete worktree at /home/u/x/zz. M README.md\nA  new1.txt'
  assert.equal(code('runtime_error', dirty), 'has_changes')
  assert.equal(code('runtime_error', 'Failed to delete worktree at /home/u/x/zz. ?? dirty.txt'), 'has_changes')
  assert.doesNotMatch(worktreeFailure('runtime_error', dirty).message, /README|new1/)
  assert.equal(code('runtime_error', 'Failed to delete worktree at /home/u/zz. fatal: locked'), 'failed')
  assert.equal(code('runtime_error', ''), 'failed')
  assert.equal(code('selector_not_found', 'selector_not_found'), 'not_found')
  assert.equal(code('runtime_unavailable', ''), 'orca_unavailable')
  assert.equal(code('brand_new_code', 'text'), 'failed')
  assert.equal(code(null, ''), 'internal')
})
