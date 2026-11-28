import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { until } from './fake-skill.ts'
import { setup } from './harness.ts'
import type { Harness } from './harness.ts'

let h: Harness
afterEach(async () => h?.stop())

test('pairing with an OS key store keeps the token in secrets and connects with a stable installation id', async () => {
  h = await setup()
  h.skill.allowPair('link-1', 'tok_' + 'a'.repeat(40))
  const res = await h.plugin.pair(' abcd 2345 ', 'My laptop')
  assert.deepEqual(res, { ok: true, link_id: 'link-1' })
  assert.equal(h.skill.pairBodies.length, 1)
  assert.deepEqual(Object.keys(h.skill.pairBodies[0]).sort(), [
    'code', 'host_label', 'installation_id', 'orca_version', 'plugin_version'
  ])
  assert.equal(h.skill.pairBodies[0].code, 'abcd2345')
  assert.equal(h.skill.pairBodies[0].orca_version, '1.4.267')
  assert.equal(h.host.secretStore.get('link:link-1'), 'tok_' + 'a'.repeat(40))
  assert.equal(h.host.store.has('token:link-1'), false)
  assert.equal(JSON.stringify([...h.host.store]).includes('tok_aaaa'), false)

  await until(() => !!h.skill.connOf('link-1')?.hello)
  const hello = h.skill.connOf('link-1')!.hello
  assert.equal(hello.v, 1)
  assert.equal(hello.installation_id, h.plugin.store.installationId)
  assert.equal(hello.plugin_version, '0.1.0')
  assert.equal(hello.orca_version, '1.4.267')
  assert.equal(hello.platform, 'linux')
  assert.deepEqual(hello.capabilities, ['send.cli', 'send.working', 'send.working:claude', 'send.working:codex', 'send.working:copilot', 'send.working:opencode'])
  assert.deepEqual(hello.projects, [])

  const id = h.plugin.store.installationId
  await h.restart()
  await until(() => (h.skill.conns.filter((c) => c.hello).length >= 2))
  assert.equal(h.plugin.store.installationId, id)
  assert.equal(h.skill.conns.at(-1)!.hello.installation_id, id)
})

test('pairing errors map to panel errors and nothing is stored', async () => {
  h = await setup()
  for (const [status, error] of [
    [400, 'invalid_code'],
    [409, 'already_linked'],
    [429, 'rate_limited'],
    [500, 'server_error']
  ] as const) {
    h.skill.pairReply = () => ({ status })
    assert.deepEqual(await h.plugin.pair('ABCD2345'), { ok: false, error })
  }
  h.skill.pairReply = () => ({ status: 200, json: { link_id: '../x', token: 'short' } })
  assert.deepEqual(await h.plugin.pair('ABCD2345'), { ok: false, error: 'server_error' })
  assert.deepEqual(await h.plugin.pair('no good!'), { ok: false, error: 'bad_input' })
  assert.equal(h.plugin.store.links.length, 0)
  assert.equal(h.host.secretStore.size, 0)
  await h.skill.close()
  assert.deepEqual(await h.plugin.pair('ABCD2345'), { ok: false, error: 'network' })
})

test('a service URL that is not https (or loopback) is refused without a request', async () => {
  h = await setup()
  h.host.settingValues = { serviceUrl: 'http://example.com/skills/orca' }
  assert.deepEqual(await h.plugin.pair('ABCD2345'), { ok: false, error: 'bad_service_url' })
  h.host.settingValues = { serviceUrl: 'https://user:pw@example.com/x' }
  assert.deepEqual(await h.plugin.pair('ABCD2345'), { ok: false, error: 'bad_service_url' })
  assert.equal(h.skill.pairBodies.length, 0)
})

test('no key store and no opt-in: linking is refused BEFORE the one-time code is spent', async () => {
  h = await setup()
  h.host.protection = 'unavailable'
  h.skill.allowPair('link-1', 'tok_' + 'b'.repeat(40))
  assert.deepEqual(await h.plugin.pair('ABCD2345'), { ok: false, error: 'keyring_unavailable' })
  assert.equal(h.skill.pairBodies.length, 0, 'the code never left this computer')
  assert.equal(h.host.secretStore.size, 0)
  assert.equal(h.host.store.has('token:link-1'), false)
  const state = await h.plugin.getState()
  assert.equal(state.protection, 'unavailable')
  assert.equal(state.token_without_keyring, false)
})

test('no key store with the opt-in: token goes to storage and a permanent warning shows', async () => {
  h = await setup()
  h.host.protection = 'unavailable'
  h.host.settingValues.allowTokenWithoutKeyring = true
  const token = 'tok_' + 'c'.repeat(40)
  h.skill.allowPair('link-1', token)
  assert.deepEqual(await h.plugin.pair('ABCD2345'), { ok: true, link_id: 'link-1' })
  assert.equal(h.host.store.get('token:link-1'), token)
  assert.equal(h.host.secretStore.size, 0)
  assert.equal(h.plugin.store.link('link-1')!.token_in_storage, true)
  await until(() => !!h.skill.connOf('link-1')?.hello)
  const state = await h.plugin.getState()
  assert.equal(state.token_without_keyring, true)
  await until(() => String(h.host.statusBar?.text).includes('token without keyring'))
  assert.equal(h.host.statusBar.tone, 'warning')
  assert.match(h.host.statusBar.tooltip, /without an OS keyring/)

  await h.restart() // it still reads the token from storage after a restart
  await until(() => h.skill.conns.filter((c) => c.hello).length >= 2)

  await h.plugin.unlink('link-1')
  assert.equal(h.host.store.has('token:link-1'), false)
  assert.equal((await h.plugin.getState()).token_without_keyring, false)
})

test('the token never appears in any log line', async () => {
  h = await setup()
  const token = 'tok_' + 'd'.repeat(40)
  h.skill.allowPair('link-1', token)
  await h.plugin.pair('SECRET99')
  await until(() => !!h.skill.connOf('link-1')?.hello)
  await h.plugin.unlink('link-1')
  const logs = h.host.logs.join('\n')
  assert.equal(logs.includes(token), false)
  assert.equal(logs.includes('SECRET99'), false)
  assert.ok(logs.length > 0)
})
