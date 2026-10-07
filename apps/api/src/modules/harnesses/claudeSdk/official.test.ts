import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { loadOfficialClaudeSdk } from './official.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })

async function installedModule(version = '0.3.284') {
  const root = await mkdtemp(join(tmpdir(), 'selected-sdk-'))
  directories.push(root)
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', version }))
  const entrypoint = join(root, 'sdk.mjs')
  await writeFile(entrypoint, `
export function query() { throw new Error('This recorded SDK cannot execute a native query') }
export async function getSessionInfo(id) { return { sessionId: id } }
export async function getSessionMessages() { return [{ selectedSdk: 'explicit-installation' }] }
export async function forkSession(id) { return { sessionId: id + '-fork' } }
`)
  return { root, entrypoint }
}

it('loads native history helpers from the explicitly selected SDK without starting a query or CLI', async () => {
  const f = await installedModule()
  const profile = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  const client = await loadOfficialClaudeSdk(profile, { root: f.root, owner: 'recorded-owner' },
    '/not-executed/claude', f.entrypoint)
  expect(client.sdkVersion).toBe('0.3.284')
  expect(await client.getSessionInfo('recorded-session', { dir: '/recorded-project' })).toEqual({ sessionId: 'recorded-session' })
  expect(await client.getSessionMessages('recorded-session', { dir: '/recorded-project' }))
    .toEqual([{ selectedSdk: 'explicit-installation' }])
})

it('refuses an unqualified SDK version or a relative entrypoint before loading its module', async () => {
  const f = await installedModule('0.3.999')
  await writeFile(f.entrypoint, "throw new Error('Unqualified module must not load')")
  const recovery = { root: f.root, owner: 'recorded-owner' }
  await expect(loadOfficialClaudeSdk('/recorded-profile', recovery, '/not-executed/claude', f.entrypoint))
    .rejects.toThrow('exact qualification candidate')
  await expect(loadOfficialClaudeSdk('/recorded-profile', recovery, '/not-executed/claude', './sdk.mjs'))
    .rejects.toThrow('qualified absolute entrypoint')
})
