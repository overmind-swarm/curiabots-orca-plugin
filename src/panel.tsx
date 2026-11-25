// The panel: link by pasting a code, see the links, choose their projects, unlink.
// No build step: Orca strips the types and compiles the JSX when the panel loads.
import {
  atom,
  Button,
  Callout,
  Card,
  Checkbox,
  Collapsible,
  EmptyState,
  env,
  Heading,
  Input,
  KeyValue,
  plugin,
  read,
  Row,
  set,
  Stack,
  Text,
  type PanelContext
} from 'orca'
import { strings } from './i18n.ts'
import type { LinkView, PanelState } from './plugin.ts'
import './protocol.ts'

type Project = { id: string; name: string; host_id: string; path: string }

export const state = atom<PanelState | null>(null)
export const loadFailed = atom(false)
export const projects = atom<Project[] | null>(null)
export const code = atom('code', '')
export const hostLabel = atom('hostLabel', '')
export const busy = atom(false)
export const pairError = atom<string | null>(null)
export const confirmUnlink = atom<string | null>(null)

async function refresh(): Promise<void> {
  try {
    set(state, await plugin.request('state.get'))
    set(loadFailed, false)
  } catch {
    set(loadFailed, true)
  }
}

async function loadProjects(): Promise<void> {
  try {
    const res = await plugin.request('projects.list')
    set(projects, res.ok ? res.projects : [])
  } catch {
    set(projects, [])
  }
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('state.changed', (next) => set(state, next)))
  void refresh()
  void loadProjects()
}

async function pair(): Promise<void> {
  set(busy, true)
  set(pairError, null)
  try {
    const label = read(hostLabel).trim()
    const res = await plugin.request('link.pair', { code: read(code), ...(label ? { host_label: label } : {}) })
    if (res.ok) set(code, '')
    else set(pairError, res.error)
  } catch {
    set(pairError, 'network')
  }
  set(busy, false)
  await refresh()
}

async function unlink(linkId: string): Promise<void> {
  if (read(confirmUnlink) !== linkId) {
    set(confirmUnlink, linkId)
    return
  }
  set(confirmUnlink, null)
  await plugin.request('link.unlink', { link_id: linkId })
  await refresh()
}

async function toggleProject(link: LinkView, project: Project, on: boolean): Promise<void> {
  const keep = link.projects.filter((p) => !(p.id === project.id && p.host_id === project.host_id))
  const next = on ? [...keep, { id: project.id, host_id: project.host_id }] : keep
  await plugin.request('link.projects.set', {
    link_id: link.link_id,
    projects: next.map((p) => ({ id: p.id, host_id: p.host_id }))
  })
  await refresh()
}

function linkCard(link: LinkView) {
  const t = strings(env.locale)
  const list = read(projects)
  const asking = read(confirmUnlink) === link.link_id
  const revoked = link.status === 'revoked'
  const tone = link.status === 'online' ? 'success' : link.status === 'connecting' ? 'accent' : 'warning'
  return (
    <Card key={link.link_id} title={link.bot_label} description={`${t.computer}: ${link.host_label}`}>
      <Stack gap="sm">
        <KeyValue
          items={[
            { label: t.status, value: t[`status.${link.status}` as keyof typeof t] ?? link.status, tone },
            { label: t.jobs, value: link.active_jobs },
            { label: t.projects, value: link.projects.length }
          ]}
        />
        {!revoked ? (
          <Collapsible title={t.projects} description={t.projectsHelp}>
            <Stack gap="xs">
              {link.projects.length === 0 ? <Text muted size="xs">{t.noProjects}</Text> : null}
              {list === null ? null : list.length === 0 ? (
                <Text muted size="xs">{t.noProjectsFound}</Text>
              ) : (
                list.map((p) => (
                  <Checkbox
                    key={`${link.link_id}:${p.host_id}:${p.id}`}
                    label={p.host_id === 'local' ? p.name : `${p.name} (${p.host_id})`}
                    description={p.path}
                    checked={link.projects.some((a) => a.id === p.id && a.host_id === p.host_id)}
                    onChange={(on: boolean) => void toggleProject(link, p, on)}
                  />
                ))
              )}
            </Stack>
          </Collapsible>
        ) : null}
        <Row gap="xs">
          <Button variant={asking ? 'solid' : 'outline'} tone="danger" size="sm" onPress={() => void unlink(link.link_id)}>
            {revoked ? t.remove : asking ? t.unlinkConfirm : t.unlink}
          </Button>
          {asking ? (
            <Button variant="ghost" size="sm" onPress={() => set(confirmUnlink, null)}>
              {t.cancel}
            </Button>
          ) : null}
        </Row>
      </Stack>
    </Card>
  )
}

export default function Panel() {
  const t = strings(env.locale)
  const s = read(state)
  const err = read(pairError)
  const working = read(busy)
  const blocked = s !== null && s.protection !== 'os-keyring' && !s.allow_without_keyring
  return (
    <Stack gap="md">
      <Heading>{t.title}</Heading>
      <Text muted size="xs">{t.intro}</Text>

      {s !== null && s.protection !== 'os-keyring' && !s.allow_without_keyring ? (
        <Callout tone="warning" title={t.noKeyringTitle}>
          <Text size="xs">{t.noKeyringBody}</Text>
        </Callout>
      ) : null}
      {s !== null && s.token_without_keyring ? (
        <Callout tone="warning" title={t.tokenWithoutKeyringTitle}>
          <Text size="xs">{t.tokenWithoutKeyringBody}</Text>
        </Callout>
      ) : null}
      {s !== null && !s.service_url_valid ? (
        <Callout tone="danger" title={t.badUrlTitle}>
          <Text size="xs">{t.badUrlBody}</Text>
        </Callout>
      ) : null}
      {s !== null && !s.cli.available ? (
        <Callout tone="neutral" title={t.noCliTitle}>
          <Text size="xs">{t.noCliBody}</Text>
        </Callout>
      ) : null}

      <Card title={t.linkTitle} description={t.linkHelp}>
        <Stack gap="sm">
          <Input
            label={t.code}
            value={read(code)}
            maxLength={40}
            disabled={working || blocked}
            onChange={(v: string) => set(code, v)}
            onSubmit={() => void pair()}
          />
          <Input
            label={t.hostLabel}
            value={read(hostLabel)}
            placeholder={s?.default_host_label ?? ''}
            maxLength={80}
            disabled={working || blocked}
            onChange={(v: string) => set(hostLabel, v)}
          />
          <Button disabled={working || blocked || read(code).trim() === ''} onPress={() => void pair()}>
            {working ? t.linking : t.link}
          </Button>
          {err ? (
            <Callout tone="danger">
              <Text size="xs">{t[`error.${err}` as keyof typeof t] ?? err}</Text>
            </Callout>
          ) : null}
        </Stack>
      </Card>

      <Heading level={2}>{t.links}</Heading>
      {s === null ? (
        read(loadFailed) ? <Text muted>...</Text> : null
      ) : s.links.length === 0 ? (
        <EmptyState title={t.noLinks} description={t.noLinksHelp} icon="link" />
      ) : (
        s.links.map((l) => linkCard(l))
      )}

      {s !== null ? (
        <Text muted size="xs">
          {t.footer} {s.plugin_version} · {s.installation} · {s.service_url}
        </Text>
      ) : null}
    </Stack>
  )
}
