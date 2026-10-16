import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { fixture } from './cloud.testSupport.js'
import { CircleCiAccounts } from './circleCiAccounts.js'
import { reservedCloudSlotKeys } from './cloudSlots.js'
import type { CloudAccount } from './cloudProviders.js'
import type { HostCiPorts } from './runner.js'
import type { HostCiComputer } from './serviceTypes.js'
import { ProductionHostCiEndpoint } from './endpoint.js'
import type { CloudCi } from './cloud.js'
import type pg from 'pg'

it('runs a further CircleCI org as its own slots on its own copy of the workspace mirror', async () => {
  const f = await fixture({}, { account: 'org2' })
  const computers = f.cloud.computers()
  expect(computers).toHaveLength(30)
  expect(computers[0]).toMatchObject({ key: 'main-1:cloud:circleci@org2:0', label: 'CircleCI org2 1',
    hostRef: { kind: 'cloud', mainId: 'main-1', provider: 'circleci', account: 'org2', slot: 0 } })
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site',
    commit: f.commit, suite: 'lint', scope: 'full' })
  const project = f.circle.triggered[0]!
  expect(project[project.indexOf('--project') + 1]).toBe('gh/org2/site-ci')
  expect(f.accountMirrorGit('for-each-ref', '--format=%(refname)', 'refs/heads/ci/')).toContain(`refs/heads/ci/${f.commit}`)
  expect(f.mirrorGit('for-each-ref', '--format=%(refname)', 'refs/heads/ci/')).toBe('')
})

it('offers no slots and refuses a start on a CircleCI org that no longer has a copy of the workspace mirror', async () => {
  const f = await fixture({}, { account: 'org2' })
  f.account!.mirrorNames.clear()
  expect(f.cloud.computers()).toEqual([])
  await expect(f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(),
    repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' }))
    .rejects.toMatchObject({ code: 'CI_CLOUD_UNAVAILABLE' })
  expect(f.circle.triggered).toEqual([])
})

function discoveryPorts(projects: Set<string>, owners = 'octo\norg2\norg3\n', broken = new Set<string>()) {
  const calls: string[] = []
  const ports: HostCiPorts = { now: () => new Date(), cpus: 1, memoryBytes: 2 ** 30, run: async (file, args) => {
    calls.push(`${file} ${args.join(' ')}`)
    if (file === 'gh') return { code: 0, stdout: owners, stderr: '' }
    const slug = args[args.indexOf('--project') + 1]!
    if (broken.has(slug)) return { code: 1, stdout: '', stderr: 'permission denied' }
    return projects.has(slug) ? { code: 0, stdout: '{}', stderr: '' }
      : { code: 1, stdout: '', stderr: `{"code":"project.not_found","message":"No project found for \\"${slug}\\"."}` }
  } }
  return { ports, calls }
}

it('adds each GitHub organization of Main whose CircleCI project copies a workspace mirror, once', async () => {
  const projects = new Set(['gh/org2/site-ci'])
  const { ports, calls } = discoveryPorts(projects)
  const added: CloudAccount[] = []
  const accounts = new CircleCiAccounts(ports, async () => ['octo/site-ci'], account => added.push(account))
  await accounts.refresh()
  expect(added.map(account => [account.owner, [...account.mirrorNames]])).toEqual([['org2', ['site-ci']]])
  // The workspace mirror's own owner is the primary CircleCI service, never a further org.
  expect(calls.some(call => call.includes('gh/octo/'))).toBe(false)
  calls.length = 0
  await accounts.refresh()
  expect(calls).toEqual([])
})

it('keeps a known CircleCI org when discovery fails and stops its starts when its project is gone', async () => {
  const projects = new Set(['gh/org2/site-ci'])
  const { ports } = discoveryPorts(projects)
  const added: CloudAccount[] = []
  let now = 0
  const accounts = new CircleCiAccounts(ports, async () => ['octo/site-ci'], account => added.push(account), { now: () => now })
  await accounts.refresh()
  projects.clear()
  now += 11 * 60_000
  await accounts.refresh()
  expect(added).toHaveLength(1)
  expect([...added[0]!.mirrorNames]).toEqual([])
  const failing: HostCiPorts = { ...ports, run: async () => ({ code: 1, stdout: '', stderr: 'network down' }) }
  const broken = new CircleCiAccounts(failing, async () => ['octo/site-ci'], account => added.push(account))
  await expect(broken.refresh()).resolves.toBeUndefined()
  expect(added).toHaveLength(1)
})

it('adds later CircleCI orgs when one org lookup fails, and restores orgs holding unfinished runs', async () => {
  const { ports } = discoveryPorts(new Set(['gh/org3/site-ci']), 'octo\norg2\norg3\n', new Set(['gh/org2/site-ci']))
  const added: CloudAccount[] = []
  const accounts = new CircleCiAccounts(ports, async () => ['octo/site-ci'], account => added.push(account),
    { runningOwners: async () => ['org9'] })
  await accounts.refresh()
  expect(added.map(account => [account.owner, [...account.mirrorNames]])).toEqual([['org9', []], ['org3', ['site-ci']]])
})

it('keeps non-gate cloud capacity in every CircleCI org', () => {
  const slots = (provider: 'github' | 'circleci', account?: string): HostCiComputer[] =>
    Array.from({ length: 3 }, (_, slot) => ({ key: `main:${provider}${account ?? ''}:${slot}`, label: provider, priority: 30,
      hostRef: { kind: 'cloud', mainId: 'main', provider, ...(account ? { account } : {}), slot } }))
  const reserved = reservedCloudSlotKeys([...slots('github'), ...slots('circleci'), ...slots('circleci', 'org2')], 3)
  expect([...reserved].sort()).toEqual(['main:circleci:2', 'main:circleciorg2:2', 'main:github:2'])
})

it('publishes the workspace mirror without waiting for a further CircleCI org to copy it', async () => {
  const published: string[] = []
  const cloud = (account?: string) => ({ provider: account ? { account: { owner: account } } : {},
    publishMirror: () => new Promise<void>(resolve => {
      published.push(account ?? 'primary')
      // The org's copy never finishes.
      if (!account) resolve()
    }) })
  const endpoint = new ProductionHostCiEndpoint({} as pg.Pool, 'main', () => undefined, { handle: async () => { throw new Error('unused') } },
    [cloud(), cloud('org2')] as unknown as CloudCi[])
  await endpoint.publishMirror({ repository: 'octo/site', mirror: 'octo/site-ci', commit: 'a'.repeat(40) })
  expect(published.sort()).toEqual(['org2', 'primary'])
})
