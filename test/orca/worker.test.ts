// Runs the real worker entry over Orca's own mock host.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from '../../src/worker.ts'

test('activates, answers the panel, and asks Orca for nothing it was not granted', async () => {
  const host = mockHost({
    results: {
      'secrets.protection': { status: 'os-keyring' },
      'project.list': { projects: [{ id: 'p1', name: 'One', kind: 'git', hostId: 'local', path: '/x' }], truncated: false }
    },
    settings: { serviceUrl: 'http://127.0.0.1:9/skills/orca', orcaCliPath: '', allowTokenWithoutKeyring: false }
  })
  const worker = await mountWorker(main, { host })
  try {
  const state: any = await worker.request('state.get')
  assert.equal(state.protection, 'os-keyring')
  assert.deepEqual(state.links, [])
  assert.equal(state.plugin_version, '0.1.0')
  const projects: any = await worker.request('projects.list')
  assert.deepEqual(projects.projects, [{ id: 'p1', name: 'One', host_id: 'local', path: '/x' }])
  assert.deepEqual((await worker.request('link.pair', { code: 'bad!code' })) as any, { ok: false, error: 'bad_input' })
  assert.deepEqual(await worker.request('link.unlink', { link_id: 'nope' }), { ok: false })
  assert.ok(host.callsOf('statusBar.update').length >= 1, 'the status bar item is updated')
  assert.deepEqual(worker.refusals, [])
  } finally {
    await worker.deactivate()
  }
})

test('delivers agent events for unknown terminals without a trace', async () => {
  const worker = await mountWorker(main, { host: mockHost({ results: { 'secrets.protection': { status: 'os-keyring' } } }) })
  await worker.emit('agent.status.changed', { workspaceId: null, paneKey: 'a:b', terminalId: 't9', state: 'working', receivedAt: 1 })
  await worker.emit('workspace.removed', { workspaceId: 'w', kind: 'worktree', path: '/p' })
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})
