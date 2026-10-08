import Fastify from 'fastify'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { BuildComputerPrepareStatusSchema, CI_RUNTIME_NAMESPACE, type PreparedCiRuntime } from '@foreman-code/contracts'
import type { PostgresAccessService } from '../src/modules/access/postgres.js'
import type { AppInteractionService } from '../src/modules/interactions/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { DomainError } from '../src/modules/errors.js'
import { registerGraphqlMcp } from '../src/mcp/unified/transport.js'
import { CiRuntimeProvisioner } from '../src/modules/jobs/ciRuntimeProvisioner.js'
import { CiRuntimeWorker } from '../src/modules/jobs/ciRuntimeWorker.js'
import { ciFixture } from './helpers/ciFixture.js'

const mainId = '11111111-1111-4111-8111-111111111111'
const dexter = '22222222-2222-4222-8222-222222222222', mana = '33333333-3333-4333-8333-333333333333'
const oldImage = `sha256:${'1'.repeat(64)}`, newImage = `sha256:${'2'.repeat(64)}`, commit = 'c'.repeat(40)
const uuid = (digit: string) => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`
const oldPin = { approvedSourceId: uuid('a'), snapshotId: uuid('b'), manifestDigest: 'a'.repeat(64) }
const newPin = { approvedSourceId: uuid('d'), snapshotId: uuid('e'), manifestDigest: 'd'.repeat(64) }
const manifest = { version: 1, ...newPin, capturePolicy: 'git-tree-v1', executablePolicy: 'preserve-approved',
  git: { commit, tree: 'f'.repeat(40), objectFormat: 'sha1' }, entries: [], deletions: [], totalEntries: 0, totalBytes: 0 }
const dexterRoot = uuid('4'), manaRoot = uuid('5')

function root(deviceId: string, rootId: string, bindingRevision: number, source = oldPin) {
  return { version: 1, source, selection: { hostRef: { kind: 'device', mainId, deviceId }, rootPolicyId: 'root-policy', rootPolicyRevision: '1', locationRevision: '2' },
    binding: { version: 1, mainId, deviceId, workerInstallationId: deviceId, workspaceId: 'workspace-fixture', rootId, bindingRevision,
      locationRevision: 2, canonicalPath: '/ci/workspaces/project', filesystem: { device: '1', inode: '2', mountId: '3' },
      accessMode: 'exclusive-write', snapshotId: source.snapshotId, manifestDigest: source.manifestDigest },
    ownerPrincipalId: 'owner', authorizedByPrincipalId: 'owner', registration: { workerInstallationId: deviceId, keyRevision: 1, authorizationRevision: 1 },
    attestationId: 'attestation', attestationDigest: '7'.repeat(64), boundAt: '2026-10-07T00:00:00.000Z' }
}
function profile(id: string, name: string, deviceId: string, rootId: string, suites: string[], memoryBytes = 6 * 2 ** 30) {
  return { schemaVersion: 2, id, name, revision: 3, status: 'qualified', sourceCommit: 'a'.repeat(40), root: root(deviceId, rootId, 1),
    approvalConfig: { review: { decisionDigest: 'e'.repeat(64) } },
    spec: { rootId, bindingRevision: 1, suites, resources: { schemaVersion: 1,
      limits: { cpuLimit: 4, memoryBytes, pidsLimit: 512, diskBytes: 20 * 2 ** 30 }, mutableInodes: 1_000_000,
      controlTempBytes: 2 ** 26, scratchBytes: 2 ** 34, scratchExecutable: true, shmBytes: 2 ** 26, spoolBytes: 2 ** 25,
      reportBytes: 2 ** 26 }, approvalConfig: {}, policy: { imageDigest: oldImage, toolchainDigest: 't' } } }
}

async function fixture(options: { prepareFails?: boolean } = {}) {
  const data = ciFixture()
  const workspaceId = data.workspaceId
  const profiles = new Map([
    ['p-install', profile('p-install', 'Dexter install', dexter, dexterRoot, ['install'])],
    ['p-unit', profile('p-unit', 'Dexter unit', dexter, dexterRoot, ['install', 'unit'])],
    ['p-mana', profile('p-mana', 'Mana install', mana, manaRoot, ['install'])],
    // Another runtime size on the same computer cannot share its one protected runtime.
    ['p-small', profile('p-small', 'Dexter small', dexter, dexterRoot, ['install'], 2 ** 30)],
  ])
  const calls = { prepare: [] as unknown[], bind: [] as unknown[], saves: [] as Array<{ id: string; spec: { bindingRevision: number; policy: { imageDigest: string } } }>,
    refresh: [] as unknown[], qualified: [] as string[] }
  const prepared: PreparedCiRuntime = { commit, imageId: newImage, imageManifestDigest: `sha256:${'9'.repeat(64)}`,
    seedReceiptPath: '/ci/installer/context/seed-receipt.json', contextReceiptPath: '/ci/installer/context/context-receipt.json',
    qualificationSource: '/ci/installer/qualification-source', unitCodex: { executable: '/opt/graphql-ci/tools/codex',
      sourceExecutable: '/ci/codex', version: 'codex-cli 1.0.0', binarySha256: '8'.repeat(64) } }
  let refreshed = false
  const workerPorts = {
    git: { cloneDirectory: (repository: string) => `/clones/${repository}`,
      git: async () => ({ code: 0, stdout: '', stderr: '' }) },
    managedRuntimeRoot: async () => '/ci/managed',
    prepare: async (input: { repository: string; commit: string; installer: string; keepImages?: readonly string[]; keepPaths?: readonly string[]; log?: (stage: string) => void }) => {
      calls.prepare.push({ repository: input.repository, commit: input.commit, installer: input.installer, keepImages: input.keepImages, keepPaths: input.keepPaths })
      input.log?.('fetch-packages')
      if (options.prepareFails) throw new Error('podman build failed: no space left on device')
      return prepared
    },
    refresh: async (input: unknown) => { calls.refresh.push(input); refreshed = true; return { unit: 'refresh', workerUnit: 'worker.service' } },
    lastRefresh: async () => refreshed ? { commit, ok: true, log: 'exit=0' } : null,
    currentRuntimePaths: async () => ['/ci/managed/installer/qualification-source-aaaaaaaaaaaa'],
    now: () => new Date('2026-10-07T00:00:00.000Z'),
  }
  let worker = new CiRuntimeWorker('/ci/state', workerPorts as never, new AbortController().signal)
  let restarted = false
  const endpoint = {
    capabilities: (deviceId: string) => deviceId === dexter ? [{ namespace: CI_RUNTIME_NAMESPACE, mainCanRequest: true }] : [],
    request: async (_deviceId: string, _namespace: string, payload: unknown) => {
      // The refresh restarts the Worker: its next status comes from a fresh process.
      if (refreshed && !restarted) { restarted = true; worker = new CiRuntimeWorker('/ci/state', workerPorts as never, new AbortController().signal) }
      return { payload: await worker.handle(payload) }
    },
  }
  const profileService = {
    list: async () => ({ profiles: [...profiles.values()].map(value => ({ profile: structuredClone(value), ready: true, reasons: [], sideEffects: false })), approvals: [] }),
    save: async (_principal: unknown, _source: unknown, _workspaceId: string, input: { id: string; expectedRevision: number; spec: never }) => {
      const current = profiles.get(input.id)!
      if (current.revision !== input.expectedRevision) throw new DomainError('REVISION_CONFLICT', 'changed', 409)
      calls.saves.push({ id: input.id, spec: input.spec })
      const saved = { ...current, revision: current.revision + 1, status: 'unqualified', spec: input.spec as typeof current.spec }
      profiles.set(input.id, saved)
      return saved
    },
    requestQualification: async (_principal: unknown, _source: unknown, _workspaceId: string, input: { profileId: string }) => ({ id: `approval-${input.profileId}` }),
    qualify: async (_principal: unknown, _source: unknown, _workspaceId: string, _commandId: string, approvalId: string) => {
      const id = approvalId.replace('approval-', '')
      calls.qualified.push(id)
      const value = { ...profiles.get(id)!, status: 'qualified', sourceCommit: commit }
      profiles.set(id, value)
      return value
    },
  }
  const newRoot = root(dexter, dexterRoot, 2, newPin)
  const sources = {
    approveProject: async () => ({ manifest }),
    rootList: async () => ({ items: [root(dexter, dexterRoot, 1), root(mana, manaRoot, 1)] }),
    bindRoot: async (_principal: unknown, _source: unknown, input: unknown) => { calls.bind.push(input); return { value: newRoot } },
  }
  const pool = { query: async () => ({ rows: [{ record: { id: workspaceId, name: 'CI',
    repository: { provider: 'github', owner: 'octo', name: 'site', defaultBranch: 'main' } } }] }) } as unknown as pg.Pool
  const ciRuntime = new CiRuntimeProvisioner(pool, profileService as never, sources as never, () => endpoint,
    data.services.commands, { pollMs: 0, wait: () => new Promise(resolve => setImmediate(resolve)), now: () => new Date('2026-10-07T00:00:00.000Z') })
  const services = { ...data.services, jobRuntimeProfiles: profileService, ciRuntime } as unknown as OperatorServices
  const app = Fastify()
  const reader = { ...data.readonly, id: 'runtime-reader', grants: [{
    actions: ['job_definitions:read' as const], scope: { workspaceIds: [workspaceId] },
  }] }
  const access = { authenticate: async (token: string) => {
    const principal = { operator: data.operator, readonly: data.readonly, reader }[token]
    if (!principal) throw new DomainError('AUTH_INVALID', 'Invalid bearer token.', 401)
    return principal
  } } as unknown as PostgresAccessService
  const interactions = { toolAccess: async () => ({ role: 'coder', tools: [] }), canRead: async () => false,
    canRespond: async () => false } as unknown as AppInteractionService
  registerGraphqlMcp(app, { access, operator: services, interactions })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const call = async (name: string, input: unknown, token = 'operator') => {
    const response = await fetch(`${address}/mcp`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream',
        'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: input } }) })
    const payload = await response.text()
    const body = payload.split('\n').find(line => line.startsWith('data: '))?.slice(6) ?? payload
    return JSON.parse(body).result as { isError?: boolean; structuredContent?: unknown; content?: { text: string }[] }
  }
  const settle = async (profileId: string) => {
    for (let attempt = 0; attempt < 500; attempt++) {
      const status = BuildComputerPrepareStatusSchema.parse((await call('build_computer_prepare_get', { workspaceId, profileId })).structuredContent)
      if (['qualified', 'failed'].includes(status.state)) return status
      await new Promise(resolve => setImmediate(resolve))
    }
    throw new Error('Preparation did not settle.')
  }
  return { ...data, app, call, settle, calls, profiles }
}

describe('build computer CI runtime preparation over the authenticated MCP endpoint', () => {
  it('prepares the computer, moves its profiles to the new image and root, refreshes it and requalifies them', async () => {
    const f = await fixture()
    try {
      const started = await f.call('build_computer_prepare', { workspaceId: f.workspaceId, profileId: 'p-unit', commandId: 'prepare-1' })
      expect(started.isError).not.toBe(true)
      expect(BuildComputerPrepareStatusSchema.parse(started.structuredContent)).toMatchObject({ deviceId: dexter, state: 'approving' })
      const done = await f.settle('p-install')
      expect(done).toMatchObject({ state: 'qualified', commit, deviceId: dexter, message: null })
      expect(done.profiles.map(value => [value.profileId, value.status]).sort()).toEqual([['p-install', 'qualified'], ['p-unit', 'qualified']])
      // The computer keeps the image and qualification source its current runtime still uses.
      expect(f.calls.prepare).toEqual([{ repository: '/clones/octo/site', commit, installer: '/ci/managed/installer', keepImages: [oldImage],
        keepPaths: ['/ci/managed/installer/qualification-source-aaaaaaaaaaaa'] }])
      expect(f.calls.bind).toEqual([expect.objectContaining({ source: newPin, expectedBindingRevision: 1, accessMode: 'exclusive-write' })])
      expect(f.calls.saves.map(value => [value.id, value.spec.bindingRevision, value.spec.policy.imageDigest]).sort())
        .toEqual([['p-install', 2, newImage], ['p-unit', 2, newImage]])
      expect(f.calls.refresh).toEqual([expect.objectContaining({ stateDirectory: '/ci/state', root: expect.objectContaining({ source: newPin }),
        resources: expect.objectContaining({ limits: expect.objectContaining({ cpuLimit: 4 }) }) })])
      expect(f.calls.qualified.sort()).toEqual(['p-install', 'p-unit'])
      // Readback: Mana's profile was not touched; Dexter's carry the commit.
      expect(f.profiles.get('p-mana')).toMatchObject({ revision: 3, spec: { policy: { imageDigest: oldImage } } })
      expect(f.profiles.get('p-small')).toMatchObject({ revision: 3, spec: { policy: { imageDigest: oldImage } } })
      expect(f.profiles.get('p-unit')).toMatchObject({ revision: 4, status: 'qualified', sourceCommit: commit })
      expect(f.audits).toContainEqual({ principalId: f.operator.id, action: 'build_computer_prepare', outcome: 'succeeded' })
    } finally { await f.app.close() }
  })

  it('reports the computer\'s failure and leaves its profiles unchanged', async () => {
    const f = await fixture({ prepareFails: true })
    try {
      await f.call('build_computer_prepare', { workspaceId: f.workspaceId, profileId: 'p-unit', commandId: 'prepare-2' })
      const done = await f.settle('p-unit')
      expect(done).toMatchObject({ state: 'failed', commit })
      expect(done.message).toContain('no space left on device')
      expect(f.calls.saves).toEqual([])
      expect(f.calls.refresh).toEqual([])
    } finally { await f.app.close() }
  })

  it('refuses a caller without the workspace grants and records the denial', async () => {
    const f = await fixture()
    try {
      const denied = await f.call('build_computer_prepare', { workspaceId: f.workspaceId, profileId: 'p-unit', commandId: 'prepare-3' }, 'readonly')
      expect(denied.isError).toBe(true)
      expect(f.calls.prepare).toEqual([])
      expect(f.audits).toContainEqual({ principalId: f.readonly.id, action: 'build_computer_prepare', outcome: 'denied' })
    } finally { await f.app.close() }
  })

  it('lets a reader follow preparation and retained profiles while denying a repeat start', async () => {
    const f = await fixture()
    try {
      await f.call('build_computer_prepare', { workspaceId: f.workspaceId, profileId: 'p-unit', commandId: 'prepare-readback' })
      await f.settle('p-unit')
      const retained = structuredClone(f.profiles.get('p-unit'))
      const read = await f.call('build_computer_prepare_get', {
        workspaceId: f.workspaceId, profileId: 'p-unit',
      }, 'reader')
      expect(read.isError).not.toBe(true)
      expect(BuildComputerPrepareStatusSchema.parse(read.structuredContent)).toMatchObject({
        state: 'qualified', commit, profiles: expect.arrayContaining([
          { profileId: 'p-unit', revision: 4, status: 'qualified' },
        ]),
      })
      const preparedCount = f.calls.prepare.length
      const denied = await f.call('build_computer_prepare', {
        workspaceId: f.workspaceId, profileId: 'p-unit', commandId: 'reader-repeat',
      }, 'reader')
      expect(denied.isError).toBe(true)
      expect(f.calls.prepare).toHaveLength(preparedCount)
      expect(f.profiles.get('p-unit')).toEqual(retained)
    } finally { await f.app.close() }
  })

})
