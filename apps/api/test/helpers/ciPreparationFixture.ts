import Fastify from 'fastify'
import type pg from 'pg'
import { BuildComputerPrepareStatusSchema, CI_RUNTIME_NAMESPACE, type CiRuntimeRequest, type PreparedCiRuntime }
  from '@foreman-code/contracts'
import { JobVerificationProfileSchema, type JobVerificationProfile } from '@foreman-code/contracts/job-verification-runtime'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { PostgresAccessService } from '../../src/modules/access/postgres.js'
import type { AppInteractionService } from '../../src/modules/interactions/app.js'
import type { OperatorServices } from '../../src/mcp/operator/types.js'
import { DomainError } from '../../src/modules/errors.js'
import { DeviceConnectionError } from '../../src/modules/devices/deviceWire.js'
import { registerGraphqlMcp } from '../../src/mcp/unified/transport.js'
import { CiRuntimeProvisioner } from '../../src/modules/jobs/ciRuntimeProvisioner.js'
import { CiRuntimeWorker } from '../../src/modules/jobs/ciRuntimeWorker.js'
import { buildComputerTarget } from '../../src/modules/settings/buildComputers.js'
import { createVerificationProfile } from '../../src/modules/jobs/verificationProfiles.js'
import { jobDigest } from '../../src/modules/jobs/digest.js'
import { ciFixture } from './ciFixture.js'
import { ciPreparationMemory } from './ciPreparationMemory.js'
import { verificationCapacityFixture } from './verificationCapacityFixture.js'

export const mainId = '11111111-1111-4111-8111-111111111111'
export const dexter = '22222222-2222-4222-8222-222222222222'
export const mana = '33333333-3333-4333-8333-333333333333'
export const oldImage = `sha256:${'1'.repeat(64)}`
export const newImage = `sha256:${'2'.repeat(64)}`
export const commit = 'c'.repeat(40)
const uuid = (digit: string) => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`
const oldPin = { approvedSourceId: uuid('a'), snapshotId: uuid('b'), manifestDigest: 'a'.repeat(64) }
export const newPin = { approvedSourceId: uuid('d'), snapshotId: uuid('e'), manifestDigest: 'd'.repeat(64) }
const dexterRoot = uuid('4'), manaRoot = uuid('5')

function root(deviceId: string, rootId: string, bindingRevision: number, source = oldPin) {
  return { version: 1 as const, source, selection: { hostRef: { kind: 'device' as const, mainId, deviceId },
    rootPolicyId: 'root-policy', rootPolicyRevision: '1', locationRevision: '2' },
    binding: { version: 1 as const, mainId, deviceId, workerInstallationId: deviceId, workspaceId: 'workspace-fixture',
      rootId, bindingRevision, locationRevision: 2, canonicalPath: '/ci/workspaces/project',
      filesystem: { device: '1', inode: '2', mountId: '3' }, accessMode: 'exclusive-write' as const,
      snapshotId: source.snapshotId, manifestDigest: source.manifestDigest },
    ownerPrincipalId: 'owner', authorizedByPrincipalId: 'owner',
    registration: { workerInstallationId: deviceId, keyRevision: 1, authorizationRevision: 1 },
    attestationId: 'attestation', attestationDigest: '7'.repeat(64), boundAt: '2026-10-07T00:00:00.000Z' }
}

export function qualifiedPreparationProfile(profile: JobVerificationProfile): JobVerificationProfile {
  const baseline = verificationCapacityFixture('device').measurement!
  const fingerprint = { ...baseline.fingerprint, profileId: profile.id, profileRevision: profile.revision,
    specDigest: profile.specDigest, root: profile.root, hostRef: profile.root.selection.hostRef,
    registration: profile.root.registration, mainInstallationId: profile.root.binding.mainId,
    sourceCommit: profile.sourceCommit!, resources: profile.spec.resources, limits: profile.spec.resources.limits,
    network: profile.spec.policy.network, imageDigest: profile.spec.policy.imageDigest,
    imageConfigDigest: profile.spec.policy.imageDigest, imageManifestDigest: profile.spec.policy.imageDigest,
    toolchainDigest: profile.spec.policy.toolchainDigest, approvalConfig: profile.approvalConfig }
  return JobVerificationProfileSchema.parse({ ...profile, status: 'qualified', measurement: { ...baseline, fingerprint,
    identity: { ...baseline.identity, profileId: profile.id, profileRevision: profile.revision,
      fingerprintDigest: jobDigest(fingerprint), rootId: profile.root.binding.rootId,
      bindingRevision: profile.root.binding.bindingRevision, imageDigest: profile.spec.policy.imageDigest,
      toolchainDigest: profile.spec.policy.toolchainDigest, network: profile.spec.policy.network },
    suites: profile.spec.suites.map(suite => ({ ...baseline.suites[0]!, suite, resources: profile.spec.resources })),
  } })
}

export function preparationProfile(id: string, name: string, deviceId: string, rootId: string,
  suites: JobVerificationProfile['spec']['suites'], memoryBytes = 6 * 2 ** 30): JobVerificationProfile {
  const baseline = verificationCapacityFixture('device')
  const resources = { ...baseline.spec.resources, limits: { ...baseline.spec.resources.limits, cpuLimit: 4, memoryBytes } }
  return qualifiedPreparationProfile(createVerificationProfile({ id, name, workspaceId: 'workspace-fixture', revision: 3,
    sourceCommit: 'a'.repeat(40), root: root(deviceId, rootId, 1), previous: null, now: new Date().toISOString(),
    spec: { ...baseline.spec, rootId, bindingRevision: 1, suites, resources,
      policy: { ...baseline.spec.policy, imageDigest: oldImage } } }))
}

type Stage = 'source' | 'root' | 'profile' | 'refresh' | 'capture' | 'qualify'
export async function ciPreparationFixture(options: {
  prepareFails?: boolean; disabled?: boolean; statusDrops?: number; loseRefreshAck?: boolean
  refreshGate?: Promise<void>
  pause?(stage: Stage): Promise<void>
} = {}) {
  const data = ciFixture()
  const workspaceId = data.workspaceId
  const profiles = new Map([
    ['p-install', preparationProfile('p-install', 'Dexter install', dexter, dexterRoot, ['install'])],
    ['p-unit', preparationProfile('p-unit', 'Dexter unit', dexter, dexterRoot, ['install', 'unit'])],
    ['p-mana', preparationProfile('p-mana', 'Mana install', mana, manaRoot, ['install'])],
    ['p-small', preparationProfile('p-small', 'Dexter small', dexter, dexterRoot, ['install'], 2 ** 30)],
  ])
  const calls = { prepare: [] as unknown[], bind: [] as unknown[],
    saves: [] as Array<{ id: string; spec: { bindingRevision: number; policy: { imageDigest: string } } }>,
    refresh: [] as unknown[], qualified: [] as string[] }
  const memory = ciPreparationMemory()
  const reader: ManagementPrincipal = { ...data.readonly, id: 'runtime-reader', grants: [{
    actions: ['job_definitions:read'], scope: { workspaceIds: [workspaceId] },
  }] }
  const principals = new Map<string, ManagementPrincipal>([
    [data.operator.id, data.operator], [data.readonly.id, data.readonly], [reader.id, reader],
  ])
  let disabled = options.disabled ?? false
  const query = async (text: string, values: unknown[] = []) => {
    if (text.includes('from management_principals')) {
      const principal = principals.get(String(values[0]))
      return { rows: principal ? [{ id: principal.id, name: principal.name, audience: principal.audience,
        grants: principal.grants, expires_at: new Date(principal.expiresAt), revoked_at: null, delegated_from: null }] : [] }
    }
    if (text.includes('from build_computer_preferences')) {
      const profile = [...profiles.values()].find(value => `${mainId}:${value.root.binding.deviceId}` === values[0])!
      const target = buildComputerTarget({ hostRef: profile.root.selection.hostRef,
        registration: profile.root.registration, mainInstallationId: mainId })
      return { rows: [{ target, revision: '1', build_enabled: !disabled, build_priority: 100,
        build_role: 'primary', build_allowance_percent: 100 }] }
    }
    if (text.includes('from workspaces')) return { rows: [{ record: { id: workspaceId, name: 'CI',
      repository: { provider: 'github', owner: 'octo', name: 'site', defaultBranch: 'main' } } }] }
    return { rows: [] }
  }
  const pool = { query, connect: async () => ({ query, release: () => {} }) } as unknown as pg.Pool
  const commands = { ...data.services.commands, execute: async (input: Parameters<typeof data.services.commands.execute>[0]) =>
    data.services.commands.execute({ ...input, authorize: async () => { await input.authorize?.(pool as never) },
      perform: async () => input.perform(pool as never) }) } as typeof data.services.commands
  const manifest = { version: 1 as const, ...newPin, capturePolicy: 'git-tree-v1' as const,
    executablePolicy: 'preserve-approved' as const, git: { commit, tree: 'f'.repeat(40), objectFormat: 'sha1' as const },
    entries: [], deletions: [], totalEntries: 0, totalBytes: 0 }
  const prepared: PreparedCiRuntime = { commit, imageId: newImage, imageManifestDigest: `sha256:${'9'.repeat(64)}`,
    seedReceiptPath: '/ci/installer/context/seed-receipt.json', contextReceiptPath: '/ci/installer/context/context-receipt.json',
    qualificationSource: '/ci/installer/qualification-source', unitCodex: { executable: '/opt/graphql-ci/tools/codex',
      sourceExecutable: '/ci/codex', version: 'codex-cli 1.0.0', binarySha256: '8'.repeat(64) } }
  let refreshRecord: { operationId: string; commit: string; ok: boolean; log: string } | null = null
  const workerPorts = {
    git: { cloneDirectory: (repository: string) => `/clones/${repository}`,
      git: async () => ({ code: 0, stdout: '', stderr: '' }) },
    managedRuntimeRoot: async () => '/ci/managed',
    prepare: async (input: { repository: string; commit: string; installer: string; keepImages?: readonly string[];
      keepPaths?: readonly string[]; log?: (stage: string) => void }) => {
      calls.prepare.push({ repository: input.repository, commit: input.commit, installer: input.installer,
        keepImages: input.keepImages, keepPaths: input.keepPaths })
      input.log?.('fetch-packages')
      if (options.prepareFails) throw new Error('podman build failed: no space left on device')
      return { ...prepared, commit: input.commit }
    },
    refresh: async (input: { operationId: string; prepared: PreparedCiRuntime }) => {
      calls.refresh.push(input)
      await options.refreshGate
      refreshRecord = { operationId: input.operationId, commit: input.prepared.commit, ok: true, log: 'exit=0' }
      return { unit: 'refresh', workerUnit: 'worker.service' }
    },
    lastRefresh: async () => refreshRecord,
    currentRuntimePaths: async () => ['/ci/managed/installer/qualification-source-aaaaaaaaaaaa'],
    now: () => new Date(),
  }
  let worker = new CiRuntimeWorker('/ci/state', workerPorts as never, new AbortController().signal)
  let restartedOperation: string | undefined
  let statusDrops = options.statusDrops ?? 0
  let ackLost = false
  const endpoint = {
    capabilities: (deviceId: string) => deviceId === dexter ? [{ namespace: CI_RUNTIME_NAMESPACE, mainCanRequest: true }] : [],
    request: async (_deviceId: string, _namespace: string, raw: unknown) => {
      const payload = raw as CiRuntimeRequest
      if (refreshRecord && restartedOperation !== refreshRecord.operationId) {
        restartedOperation = refreshRecord.operationId
        worker = new CiRuntimeWorker('/ci/state', workerPorts as never, new AbortController().signal)
      }
      if (payload.operation === 'status' && statusDrops-- > 0) throw new DeviceConnectionError('transport')
      const state = await worker.handle(payload)
      if (payload.operation === 'refresh') {
        await options.pause?.('refresh')
        if (options.loseRefreshAck && !ackLost) { ackLost = true; throw new DeviceConnectionError('transport') }
      }
      return { payload: state }
    },
  }
  const command = async <T>(principal: ManagementPrincipal, operation: string,
    input: { commandId: string; approvalId?: string },
    perform: () => Promise<T>) => (await commands.execute({ principal, source: 'mcp', operation,
      commandId: input.commandId, targetKey: workspaceId, payload: input, perform })).value
  const currentRoots = new Map([[dexterRoot, root(dexter, dexterRoot, 1)], [manaRoot, root(mana, manaRoot, 1)]])
  const sources = {
    approveProject: async (principal: ManagementPrincipal, input: { commandId: string; commit?: string }) => {
      const approved = await command(principal, 'fixture.source', input,
        async () => ({ manifest: { ...manifest, git: { ...manifest.git, commit: input.commit ?? commit } } }))
      await options.pause?.('source')
      return approved
    },
    rootList: async () => ({ items: [...currentRoots.values()].map(value => structuredClone(value)) }),
    bindRoot: async (principal: ManagementPrincipal, _source: unknown,
      input: { commandId: string; expectedBindingRevision: number; selection: { hostRef: { deviceId: string } } }) => {
      const result = await command(principal, 'fixture.root', input, async () => {
        calls.bind.push(input)
        const current = currentRoots.get(dexterRoot)!
        if (current.binding.bindingRevision !== input.expectedBindingRevision) throw new DomainError('REVISION_CONFLICT', 'changed', 409)
        const value = root(dexter, dexterRoot, current.binding.bindingRevision + 1, newPin)
        currentRoots.set(dexterRoot, value)
        return { value }
      })
      await options.pause?.('root')
      return result
    },
  }
  const profileService = {
    list: async (_principal: unknown, scope: string) => ({ profiles: [...profiles.values()]
      .filter(profile => profile.workspaceId === scope).map(profile => ({ profile: structuredClone(profile),
      ready: true, reasons: [], sideEffects: false })), approvals: [] }),
    save: async (principal: ManagementPrincipal, _source: unknown, scope: string,
      input: { id: string; commandId: string; expectedRevision: number; name: string; spec: JobVerificationProfile['spec'] }) => {
      const saved = await command(principal, 'fixture.profile', input, async () => {
        const current = profiles.get(input.id)!
        if (current.revision !== input.expectedRevision) throw new DomainError('REVISION_CONFLICT', 'changed', 409)
        calls.saves.push(input)
        const value = createVerificationProfile({ id: input.id, name: input.name, workspaceId: scope,
          revision: current.revision + 1, sourceCommit: commit, root: currentRoots.get(input.spec.rootId)!,
          spec: input.spec, previous: current, now: new Date().toISOString() })
        profiles.set(input.id, value)
        return value
      })
      await options.pause?.('profile')
      return saved
    },
    requestQualification: async (principal: ManagementPrincipal, _source: unknown, _scope: string,
      input: { commandId: string; profileId: string }) => {
      const result = await command(principal, 'fixture.capture', input, async () => ({ id: `approval-${input.profileId}` }))
      await options.pause?.('capture')
      return result
    },
    qualify: async (principal: ManagementPrincipal, _source: unknown, _scope: string, commandId: string, approvalId: string) => {
      const result = await command(principal, 'fixture.qualify', { commandId, approvalId }, async () => {
        const id = approvalId.replace('approval-', '')
        calls.qualified.push(id)
        const value = qualifiedPreparationProfile(profiles.get(id)!)
        profiles.set(id, value)
        return value
      })
      await options.pause?.('qualify')
      return result
    },
  }
  const createProvisioner = () => new CiRuntimeProvisioner(pool, profileService as never, sources as never,
    () => endpoint, commands, { ...memory, timing: { pollMs: 0,
      wait: () => new Promise(resolve => setImmediate(resolve)), now: () => new Date() } })
  const ciRuntime = createProvisioner()
  const services = { ...data.services, commands, jobRuntimeProfiles: profileService, ciRuntime } as unknown as OperatorServices
  const app = Fastify()
  const access = { authenticate: async (token: string) => {
    const principal = { operator: data.operator, readonly: data.readonly, reader }[token]
    if (!principal) throw new DomainError('AUTH_INVALID', 'Invalid bearer token.', 401)
    return principal
  } } as unknown as PostgresAccessService
  const interactions = { toolAccess: async () => ({ role: 'coder', tools: [] }), canRead: async () => false,
    canRespond: async () => false } as unknown as AppInteractionService
  registerGraphqlMcp(app, { access, operator: services, interactions })
  const url = await app.listen({ port: 0, host: '127.0.0.1' })
  const call = async (name: string, input: unknown, token = 'operator') => {
    const response = await fetch(`${url}/mcp`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream',
        'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: input } }) })
    const responseBody = await response.text()
    const body = responseBody.split('\n').find(line => line.startsWith('data: '))?.slice(6) ?? responseBody
    return JSON.parse(body).result as { isError?: boolean; structuredContent?: unknown; content?: { text: string }[] }
  }
  const settle = async (profileId: string, provisioner = ciRuntime) => {
    for (let attempt = 0; attempt < 500; attempt++) {
      const status = BuildComputerPrepareStatusSchema.parse(await provisioner.get(data.operator, { workspaceId, profileId }))
      if (['qualified', 'failed'].includes(status.state)) return status
      await new Promise(resolve => setImmediate(resolve))
    }
    throw new Error('Preparation did not settle.')
  }
  return { ...data, app, call, settle, calls, profiles, sources, profileService, pool, ciRuntime,
    createProvisioner, memory, principals, commands, endpoint, disable: () => { disabled = true },
    workerState: () => worker.handle({ operation: 'status' }) }
}
