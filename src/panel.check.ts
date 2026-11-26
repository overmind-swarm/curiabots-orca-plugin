// `orca plugin check` renders the panel once per scenario against the worker on a mock host.
import { defineCheck } from 'orca/testing'

const projects = {
  projects: [
    { id: 'p1', name: 'Repo One', kind: 'git', hostId: 'local', path: '/work/one' },
    { id: 'p3', name: 'Remote', kind: 'git', hostId: 'ssh:box', path: '/srv/r' }
  ],
  truncated: false
}

export default defineCheck({
  empty: { results: { 'project.list': projects } },
  linked: {
    results: { 'project.list': projects },
    storage: {
      installation_id: '0f0f0f0f-aaaa-bbbb-cccc-000000000001',
      links: [
        {
          link_id: 'link-1',
          bot_label: 'T.A.R.S.',
          host_label: 'laptop',
          service_url: 'https://api.curiabots.com/skills/orca',
          allowed_projects: [{ id: 'p1', host_id: 'local', name: 'Repo One' }],
          created_at: 0
        }
      ]
    },
    secrets: { 'link:link-1': 'token-for-the-check-0000000000' }
  },
  linkedNoProjects: {
    results: { 'project.list': projects },
    storage: {
      installation_id: '0f0f0f0f-aaaa-bbbb-cccc-000000000001',
      links: [
        {
          link_id: 'link-1',
          bot_label: 'Marvin',
          link_name: 'Laptop of Sergio',
          host_label: 'laptop',
          service_url: 'https://api.curiabots.com/skills/orca',
          allowed_projects: [],
          created_at: 0
        }
      ]
    },
    secrets: { 'link:link-1': 'token-for-the-check-0000000000' }
  },
  linkedAllProjects: {
    results: { 'project.list': projects },
    storage: {
      installation_id: '0f0f0f0f-aaaa-bbbb-cccc-000000000001',
      links: [
        {
          link_id: 'link-1',
          bot_label: 'Marvin',
          host_label: 'laptop',
          service_url: 'https://api.curiabots.com/skills/orca',
          allowed_projects: [],
          allow_all_projects: true,
          created_at: 0
        }
      ]
    },
    secrets: { 'link:link-1': 'token-for-the-check-0000000000' }
  }
})
