import { afterEach, assert, mockHost, mount, test } from 'orca/testing'
import type { TestPanel } from 'orca/testing'
import * as panel from '../../src/panel.tsx'

// Titles and descriptions are props of the drawn tree, so look for the text anywhere in it.
const shows = (v: TestPanel, text: string) => JSON.stringify(v.tree()).includes(JSON.stringify(text).slice(1, -1))

let view: TestPanel | undefined
afterEach(() => view?.unmount())

const base = {
  protection: 'os-keyring',
  allow_without_keyring: false,
  token_without_keyring: false,
  cli: { available: true, path: '/x/orca' },
  service_url: 'https://api.curiabots.com/skills/orca',
  service_url_valid: true,
  installation: '0f0f0f0f',
  plugin_version: '0.1.0',
  default_host_label: 'laptop',
  links: [] as any[]
}
const link = {
  link_id: 'l1', bot_label: 'T.A.R.S.', host_label: 'laptop', status: 'online', last_error: null,
  active_jobs: 2, projects: [{ id: 'p1', host_id: 'local', name: 'One' }], token_in_storage: false
}
const projects = [
  { id: 'p1', name: 'One', host_id: 'local', path: '/one' },
  { id: 'p3', name: 'Remote', host_id: 'ssh:box', path: '/r' }
]

test('links a code and shows the link with its status and jobs', async () => {
  let state: any = { ...base }
  const calls: any[] = []
  const host = mockHost({
    requests: {
      'state.get': () => state,
      'projects.list': () => ({ ok: true, projects }),
      'link.pair': (input: any) => {
        calls.push(input)
        state = { ...base, links: [link] }
        return { ok: true, link_id: 'l1' }
      }
    }
  })
  view = await mount(panel, { host })
  assert.ok(shows(view, 'No agent linked yet'))
  await view.type({ label: 'Linking code' }, 'ABCD2345')
  await view.press({ text: 'Link' })
  assert.deepEqual(calls, [{ code: 'ABCD2345' }])
  assert.ok(shows(view, 'T.A.R.S.'))
  assert.equal(view.valueOf({ label: 'Linking code' }), '')
  assert.ok(shows(view, 'Online'))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
})

test('a refused code shows the error and keeps the code', async () => {
  const host = mockHost({
    requests: {
      'state.get': () => base,
      'projects.list': () => ({ ok: true, projects }),
      'link.pair': () => ({ ok: false, error: 'invalid_code' })
    }
  })
  view = await mount(panel, { host })
  await view.type({ label: 'Linking code' }, 'WRONG123')
  await view.press({ text: 'Link' })
  assert.ok(shows(view, 'That code is not valid, was already used or has expired.'))
  assert.equal(view.valueOf({ label: 'Linking code' }), 'WRONG123')
})

test('without a key store linking is disabled and explained', async () => {
  const host = mockHost({
    requests: { 'state.get': () => ({ ...base, protection: 'unavailable' }), 'projects.list': () => ({ ok: true, projects: [] }) }
  })
  view = await mount(panel, { host })
  assert.ok(shows(view, 'No OS key store available'))
  assert.ok(view.find({ role: 'button', text: 'Link' })?.disabled !== false)
  assert.deepEqual(view.errors, [])
})

test('the opt-in shows a permanent "token stored without a keyring" warning', async () => {
  const host = mockHost({
    requests: {
      'state.get': () => ({ ...base, protection: 'unavailable', allow_without_keyring: true, token_without_keyring: true, links: [{ ...link, token_in_storage: true }] }),
      'projects.list': () => ({ ok: true, projects })
    }
  })
  view = await mount(panel, { host })
  assert.ok(shows(view, 'Token stored without a keyring'))
  assert.equal(shows(view, 'No OS key store available'), false)
})

test('projects are chosen per link and unlink needs a second press', async () => {
  const set: any[] = []
  const unlinked: any[] = []
  const host = mockHost({
    requests: {
      'state.get': () => ({ ...base, links: [link] }),
      'projects.list': () => ({ ok: true, projects }),
      'link.projects.set': (input: any) => (set.push(input), { ok: true }),
      'link.unlink': (input: any) => (unlinked.push(input), { ok: true })
    }
  })
  view = await mount(panel, { host })
  await view.toggle({ type: 'Collapsible' })
  await view.toggle({ label: 'Remote (ssh:box)' })
  assert.deepEqual(set, [{ link_id: 'l1', projects: [{ id: 'p1', host_id: 'local' }, { id: 'p3', host_id: 'ssh:box' }] }])
  await view.press({ text: 'Unlink' })
  assert.deepEqual(unlinked, [])
  await view.press({ text: 'Confirm unlink' })
  assert.deepEqual(unlinked, [{ link_id: 'l1' }])
})

test('the panel follows pushes from the worker and speaks Spanish', async () => {
  const host = mockHost({ requests: { 'state.get': () => base, 'projects.list': () => ({ ok: true, projects: [] }) } })
  view = await mount(panel, { host, locale: 'es-ES' })
  assert.ok(shows(view, 'Todavía no hay ningún agente vinculado'))
  await view.post('state.changed', { ...base, links: [{ ...link, status: 'offline' }] })
  assert.ok(shows(view, 'Desconectado, reintentando'))
  await view.post('state.changed', { ...base, links: [{ ...link, status: 'revoked' }] })
  assert.ok(view.find({ role: 'button', text: 'Quitar' }))
})
