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
  Switch,
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
/** Links whose projects section the user opened or closed by hand; the rest follow `needsProjects`. */
export const projectsOpen = atom<Record<string, boolean>>({})

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

async function setAllowAll(link: LinkView, on: boolean): Promise<void> {
  await plugin.request('link.projects.allowAll', { link_id: link.link_id, on })
  await refresh()
}

async function trust(p: { id: string; host_id: string }): Promise<void> {
  await plugin.request('projects.trust', { id: p.id, host_id: p.host_id })
  await refresh()
}

async function setAllowAdd(link: LinkView, on: boolean): Promise<void> {
  await plugin.request('link.addProjects.allow', { link_id: link.link_id, on })
  await refresh()
}

function setOpen(linkId: string, open: boolean): void {
  set(projectsOpen, { ...read(projectsOpen), [linkId]: open })
}

/** "All", or how many projects are allowed and which ones (the first three). */
export function projectsSummary(link: LinkView, t: ReturnType<typeof strings>): string {
  if (link.allow_all_projects) return t.allProjects
  if (link.projects.length === 0) return t.noneAllowed
  const names = link.projects.slice(0, 3).map((p) => p.name)
  const more = link.projects.length > 3 ? ` +${link.projects.length - 3}` : ''
  return `${link.projects.length}: ${names.join(', ')}${more}`
}

function linkCard(link: LinkView) {
  const t = strings(env.locale)
  const list = read(projects)
  const asking = read(confirmUnlink) === link.link_id
  const revoked = link.status === 'revoked'
  const needsProjects = !revoked && !link.allow_all_projects && link.projects.length === 0
  const isOpen = read(projectsOpen)[link.link_id] ?? needsProjects
  const tone = link.status === 'online' ? 'success' : link.status === 'connecting' ? 'accent' : 'warning'
  return (
    <Card
      key={link.link_id}
      title={link.bot_label}
      description={`${link.link_name ? `${link.link_name} · ` : ''}${t.computer}: ${link.host_label}`}
    >
      <Stack gap="sm">
        <KeyValue
          items={[
            { label: t.status, value: t[`status.${link.status}` as keyof typeof t] ?? link.status, tone },
            { label: t.jobs, value: link.active_jobs },
            { label: t.projects, value: projectsSummary(link, t), tone: needsProjects ? 'warning' : undefined }
          ]}
        />
        {needsProjects && !isOpen ? (
          <Callout tone="warning" title={t.needsProjectsTitle}>
            <Stack gap="xs">
              <Text size="xs">{t.needsProjectsBody}</Text>
              <Button size="sm" onPress={() => setOpen(link.link_id, true)}>
                {t.chooseProjects}
              </Button>
            </Stack>
          </Callout>
        ) : null}
        {!revoked ? (
          <Collapsible
            title={`${t.projects}: ${projectsSummary(link, t)}`}
            description={t.projectsHelp}
            open={isOpen}
            onChange={(open: boolean) => setOpen(link.link_id, open)}
          >
            <Stack gap="xs">
              {needsProjects ? (
                <Callout tone="warning" title={t.needsProjectsTitle}>
                  <Text size="xs">{t.needsProjectsBody}</Text>
                </Callout>
              ) : null}
              <Switch
                label={t.allowAll}
                checked={link.allow_all_projects}
                onChange={(on: boolean) => void setAllowAll(link, on)}
              />
              {link.allow_all_projects ? (
                <Callout tone="danger" title={t.allowAllWarningTitle}>
                  <Text size="xs">{t.allowAllWarning}</Text>
                </Callout>
              ) : (
                <Text muted size="xs">{t.allowAllHelp}</Text>
              )}
              {link.allow_all_projects ? null : list === null ? null : list.length === 0 ? (
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
        {!revoked ? addProjectsSection(link, t) : null}
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

/** "Allow adding projects" (dev#2424): off by default; it can only be turned on once the clone folder is set and valid. */
function addProjectsSection(link: LinkView, t: ReturnType<typeof strings>) {
  const root = read(state)?.clone_root ?? { configured: false, valid: false }
  return (
    <Stack gap="xs">
      <Switch
        label={t.allowAdd}
        checked={link.allow_add_projects}
        disabled={!link.allow_add_projects && !root.valid}
        onChange={(on: boolean) => void setAllowAdd(link, on)}
      />
      {!root.valid ? (
        <Text muted size="xs">{root.configured ? t.allowAddBadRoot : t.allowAddNoRoot}</Text>
      ) : link.allow_add_projects ? (
        <Callout tone="warning" title={t.allowAddWarningTitle}>
          <Text size="xs">{t.allowAddWarning}</Text>
        </Callout>
      ) : (
        <Text muted size="xs">{t.allowAddHelp}</Text>
      )}
    </Stack>
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

      {s !== null && s.added_projects.length > 0 ? (
        <Callout tone="warning" title={t.addedTitle}>
          <Stack gap="xs">
            <Text size="xs">{t.addedBody}</Text>
            {s.added_projects.map((p) => (
              <Row key={`${p.host_id}:${p.id}`} gap="xs">
                <Text size="xs">{p.name}</Text>
                <Button size="sm" variant="outline" onPress={() => void trust(p)}>
                  {t.addedTrust}
                </Button>
              </Row>
            ))}
          </Stack>
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
