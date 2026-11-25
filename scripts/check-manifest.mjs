// Release guard, run by CI and by the release workflow: the manifest must be coherent and must not
// quietly ask for more access than the contract needs. Plain Node, no dependencies.
import { readFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync(new URL('../orca-plugin.json', import.meta.url), 'utf8'))
const versionTs = readFileSync(new URL('../src/version.ts', import.meta.url), 'utf8')
const errors = []

const fail = (message) => errors.push(message)
if (manifest.id !== 'curiabots') fail(`id must be "curiabots", got ${manifest.id}`)
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) fail(`version must be x.y.z, got ${manifest.version}`)
if (!versionTs.includes(`'${manifest.version}'`)) fail('src/version.ts does not match the manifest version')
if (manifest.license !== 'MIT') fail('license must be MIT')
if (manifest.execution !== 'trusted-worker') fail('execution must be trusted-worker')

const allowed = [
  'agent:launch', 'agent:read', 'secrets:own', 'settings:own', 'storage:own',
  'terminal:read', 'terminal:send', 'workspace:create', 'workspace:read'
]
const asked = (manifest.capabilities ?? []).map((c) => c.kind).sort()
if (JSON.stringify(asked) !== JSON.stringify(allowed)) {
  fail(`capabilities changed: ${asked.join(', ')} (expected ${allowed.join(', ')}). Update the contract and README first.`)
}
const service = manifest.contributes?.settings?.find((s) => s.key === 'serviceUrl')
if (service?.default !== 'https://api.curiabots.com/skills/orca') fail('serviceUrl default must be the production URL')
const optIn = manifest.contributes?.settings?.find((s) => s.key === 'allowTokenWithoutKeyring')
if (optIn?.default !== false) fail('allowTokenWithoutKeyring must default to false')

if (errors.length) {
  for (const e of errors) console.error('error:', e)
  process.exit(1)
}
console.log(`manifest ok: curiabots ${manifest.version}`)
