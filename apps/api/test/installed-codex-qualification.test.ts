import { join } from 'node:path'
import { persistentFixtureRoot } from './helpers/fixtureStorage.js'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, withAdvancedDefaults } from '@foreman-code/contracts'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { ExecutionFactsResultSchema } from '@foreman-code/contracts/execution-authority'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { loadOrCreateWorkerIdentity, persistWorkerPairing } from '@foreman-code/contracts/device-identity-node'
import { createInstalledCodexQualificationReader } from '../src/modules/harnesses/installedCodexQualification.js'
import type { InstalledCodexInspection } from '../src/modules/harnesses/installedCodexInspection.js'
import { harnessConnectionGeneration } from '../src/modules/harnesses/hostConnectionGeneration.js'
import { HarnessQualificationRegistry } from '../src/modules/harnesses/qualification/registry.js'
import { agentInstructionBundle } from '../src/modules/skills/instructions.js'
import { skillHash } from '../src/modules/skills/catalog.js'

const mount = vi.hoisted(() => ({ revision: '', manifest: {} as unknown,
  bootId: '44444444-4444-4444-8444-444444444444',
}))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: async (...args: Parameters<typeof actual.readFile>) =>
    args[0] instanceof URL && args[0].pathname.endsWith('/apps/worker/manifest.json')
      ? JSON.stringify(mount.manifest) : actual.readFile(...args) }
})
vi.mock('../src/modules/devices/installedWorkerDomains.ts', () => ({
  createInstalledWorkerDomains: async (input: { codexSuiteRevision: string }) => {
    mount.revision = input.codexSuiteRevision
    return { extensions: [], close: async () => {} }
  },
}))
vi.mock('../src/modules/devices/workerConnection.ts', () => ({ createWorkerConnection: () => ({}) }))
vi.mock('../../worker/src/runtime.mjs', () => ({
  acquireWorkerLock: async () => async () => {},
  startWorker: async (input: { createConnection(input: { bootId: string }): Promise<unknown>; beforeUnlock(): Promise<void> }) => {
    await input.createConnection({ bootId: mount.bootId })
    return { stop: input.beforeUnlock }
  },
}))

// Complete module loading before creating test state and starting the behavior deadline.
const diagnosticsPath = new URL('../../worker/src/diagnostics.mjs', import.meta.url).href
const { hostFacts } = await import(diagnosticsPath)
const factoryPath = new URL('../../worker/src/workerFactory.mjs', import.meta.url).href
const { startConfiguredWorker } = await import(factoryPath)

function fixture(options: {
  suiteRevision?: string
  binding?: DeviceSessionBinding
  harness?: 'codex'
  assertResident?: Parameters<typeof createInstalledCodexQualificationReader>[0]['assertResident']
} = {}) {
  const harness = options.harness ?? 'codex'
  const suiteRevision = options.suiteRevision ?? `${harness}-live-4`
  const version = harness === 'codex' ? '0.132.0' : '1.18.31'
  const binding = options.binding ?? {
    mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(), bootId: randomUUID(),
    keyRevision: 2, authorizationRevision: 3, connectionGeneration: 4, connectionEpoch: randomUUID(),
  }
  const hostRef = { kind: 'device' as const, mainId: binding.mainId, deviceId: binding.deviceId }
  const target = { hostRef, applicationInstallationId: binding.workerInstallationId, harnessInstallationId: `actual-${harness}-installation`, installationFingerprint: 'actual-whole-launcher-fingerprint' }
  const sha = 'a'.repeat(64), hash = 'b'.repeat(64), timestamp = '2026-10-01T00:00:00.000Z'
  const environment = { generation: 'actual-worker-environment', provenance: 'worker' as const, cwd: '/state', path: '/usr/bin' }
  const installation = { hostRef, harnessInstallationId: target.harnessInstallationId, installationFingerprint: target.installationFingerprint,
    driverId: harness, driverRevision: '1', protocolRevision: `${harness}-native-adapter-v1`, environmentGeneration: environment.generation,
    connectionGeneration: harnessConnectionGeneration(binding), launcher: { requested: `/installed/${harness}`, resolvedLauncher: `/installed/${harness}`,
      fingerprint: target.installationFingerprint, payloadFingerprints: [{ path: `/installed/${harness}`, fingerprint: sha }],
      status: 'installed' as const, interpreter: null, diagnostics: [], environment, checkedAt: timestamp },
    observedVersion: version, installed: true, authenticated: null, compatible: null, qualified: true }
  const configuration = { id: 'configuration', agentId: 'agent', workspaceId: 'workspace', version: 1,
    prompt: { system: 'test' }, assignedSkills: [], harness: DEFAULT_HARNESS_DEFAULTS[harness], contentHash: 'configuration-hash', createdAt: timestamp }
  const instanceId = randomUUID(), fingerprint = commandInputHash(withAdvancedDefaults(configuration.harness))
  const override = { instanceId, revision: 1, instanceRevision: 'immutable-instance-revision', target, presetId: 'preset', enabled: true,
    driverId: harness, configuration: configuration.harness, configurationFingerprint: fingerprint, qualification: 'qualified' }
  const profileProof = { target, instanceRevision: override.instanceRevision, configurationFingerprint: fingerprint,
    driverId: harness, driverRevision: installation.driverRevision, protocolRevision: installation.protocolRevision,
    suiteRevision: `${harness}-profile-check-v1`, environmentGeneration: environment.generation, connectionGeneration: installation.connectionGeneration,
    authenticated: true, compatible: true, qualified: true, checkedAt: timestamp }
  const qualification = { harness, version, binarySha256: sha, status: 'qualified', profile: 'codex-0.156',
    suiteRevision: `${harness}-live-4`, checks: [{ id: 'actual-native-qualification', passed: true, detail: null }], failureReason: null, startedAt: timestamp, checkedAt: timestamp }
  const placement = { schemaVersion: 1, mainId: binding.mainId, runId: 'run', nodeId: 'node', hostRef,
    registration: { workerInstallationId: binding.workerInstallationId, keyRevision: binding.keyRevision, authorizationRevision: binding.authorizationRevision },
    mainInstallationId: binding.mainId, destination: { canonicalProjectRoot: '/project', canonicalCwd: '/project', managedRuntimeRoot: '/runtime',
      directoryIdentityHash: hash, rootPolicyId: 'policy', rootPolicyRevision: '1', locationRevision: '1', attestationId: 'attestation', attestationHash: hash },
    source: { revisionId: 'source', manifestDigest: hash, materializationId: randomUUID(), materializationDigest: hash },
    payload: { kind: 'agent', agentId: configuration.agentId, agentConfigurationVersionId: configuration.id, driverId: harness,
      driverRevision: installation.driverRevision, instanceId, instanceRevision: override.instanceRevision,
      harnessInstallationId: target.harnessInstallationId, installationFingerprint: target.installationFingerprint,
      runtimeContractVersion: 1, protocolRevision: installation.protocolRevision, credentialScopeRefs: [] }, bindingHash: hash }
  const intent = { schemaVersion: 1, protocolVersion: 1, mainId: binding.mainId, runId: 'run', nodeId: 'node', executionId: 'execution',
    occurrenceId: null, occurrenceIndex: 0, technicalAttempt: 1, attemptId: 'attempt', operationId: 'operation', bindingHash: hash,
    inputDigest: `sha256:${hash}`, owner: { grantId: 'grant', epoch: '1' } }
  const filesystem = { device: '1', inode: '2', mountId: '3' }
  const root = { version: 1, mainId: binding.mainId, deviceId: binding.deviceId, workerInstallationId: binding.workerInstallationId,
    workspaceId: 'workspace', rootId: randomUUID(), bindingRevision: 1, locationRevision: 1, canonicalPath: '/project', filesystem,
    accessMode: 'read-only', snapshotId: randomUUID(), manifestDigest: hash }
  const materialization = { receipt: { version: 1, materializationId: placement.source.materializationId, binding: root,
    placementHash: hash, executionId: 'execution', attemptId: 'attempt', keyRevision: binding.keyRevision, authorizationRevision: binding.authorizationRevision,
    verifiedManifestDigest: hash, verifiedEntries: 0, verifiedBytes: 0, verifiedAt: timestamp, localTreeIdentity: filesystem },
    rootPolicyId: 'policy', rootPolicyRevision: '1', operationId: 'operation', reservationId: randomUUID(), sourceBindingHash: hash,
    finalDispatchBindingHash: hash, state: 'prepared' }
  const facts = ExecutionFactsResultSchema.parse({ version: 1, intent, placement, configuration, harness: { override, profileProof, installation, qualification },
    executionPlacement: { version: 1, acceptedBindingHash: hash, runId: 'run', nodeId: 'node', executionId: 'execution', attemptId: 'attempt', operationId: 'operation',
      materialization, workingTree: { materializationId: placement.source.materializationId, materializationDigest: hash, canonicalProjectRoot: '/project',
        canonicalCwd: '/project', directoryIdentityHash: hash, filesystem, accessMode: 'read-only', privateGit: null }, bindingHash: hash } })
  const inspection: InstalledCodexInspection = { inventory: { instances: [], installations: [{ ...facts.harness.installation, observedVersion: null, qualified: false }] },
    currentTarget: { binding, target, installation: { ...facts.harness.installation, observedVersion: null, qualified: false }, binarySha256: sha, expectedVersion: version } }
  let live: typeof binding | null = binding
  const inspect = vi.fn(async () => structuredClone(inspection)), readFacts = vi.fn(async () => structuredClone(facts))
  const controller = new AbortController()
  const readerInput = { intent: facts.intent, placement: facts.placement, trustedCurrentBinding: () => live,
    inspect, readFacts, suiteRevision, signal: controller.signal,
    ...(options.assertResident ? { assertResident: options.assertResident } : {}) }
  const reader = harness === 'codex' ? createInstalledCodexQualificationReader(readerInput)
    : createInstalledCodexQualificationReader(readerInput)
  return { facts, inspection, reader, inspect, readFacts, controller, binding, setLive: (value: typeof live) => { live = value } }
}

describe('actual Main and installed Codex qualification read capability', () => {
  it.each(['codex', 'opencode'] as const)('uses Main’s saved %s settings, prompts and skills without an offline copy', async harness => {
    const f = fixture({ harness })
    f.facts.configuration.prompt = { system: 'Instructions saved on Main.' }
    f.facts.configuration.instructionDelivery = 'native-v1'
    f.facts.configuration.assignedSkills = [{ skillId: 'shared-skill', version: '2' }]
    f.facts.configuration.resolvedSkills = [{ skillId: 'shared-skill', version: '2', name: 'Shared skill',
      instructions: 'Skill text saved on Main.', contentHash: skillHash('Skill text saved on Main.') }]
    const accepted = (await f.reader.capture()).facts.configuration
    expect(accepted.harness).toEqual(f.facts.harness.override.configuration)
    expect(agentInstructionBundle(accepted)?.text).toContain('Instructions saved on Main.')
    expect(agentInstructionBundle(accepted)?.text).toContain('Skill text saved on Main.')
    f.readFacts.mockRejectedValueOnce(new Error('Main disconnected'))
    await expect(f.reader.capture()).rejects.toThrow('Main disconnected')
  })
  it('accepts producer-shaped identity-qualified proof through the shipped worker mount and keeps exact revision checks', async () => {
    const stateDirectory = await mkdtemp(join(persistentFixtureRoot, 'graphql-codex-revision-'))
    try {
      const facts = await hostFacts(process.env.HOME ?? '', [stateDirectory])
      mount.manifest = { format: 1, version: '0.1.0', commit: 'a'.repeat(40), lockfileSha256: 'b'.repeat(64),
        protocolVersion: 1, identityFormat: 1, packageManager: 'pnpm@11.27.0',
        target: { os: facts.os, osRelease: facts.osRelease, arch: facts.arch, libc: facts.libc, node: facts.node },
        files: [{ path: 'src/cli.mjs', sha256: 'c'.repeat(64), size: 0 }] }
      const identity = await loadOrCreateWorkerIdentity(stateDirectory)
      const original = { ...fixture().binding, workerInstallationId: identity.workerInstallationId, keyRevision: identity.keyRevision }
      await persistWorkerPairing(stateDirectory, { formatVersion: 1, mainId: original.mainId, deviceId: original.deviceId,
        workerInstallationId: original.workerInstallationId, keyRevision: original.keyRevision, authorizationRevision: original.authorizationRevision,
        endpoint: 'wss://main.example/device/connect', mainPublicKeyFingerprint: 'd'.repeat(64), credential: 'e'.repeat(64),
        expiresAt: '2099-01-01T00:00:00Z' })
      mount.bootId = original.bootId
      const worker = await startConfiguredWorker({ stateDirectory })
      try {
        expect(mount.revision).toBe('codex-live-5+identity-v1')
        const f = fixture({ suiteRevision: mount.revision, binding: original })
        f.facts.harness.qualification.suiteRevision = 'codex-live-5+identity-v1'
        expect((await f.reader.capture()).qualification).toEqual(f.facts.harness.qualification)
        expect(await f.reader.repository.find('codex', '0.132.0', 'a'.repeat(64), 'codex-live-5+identity-v1')).toEqual(f.facts.harness.qualification)
        const gate = new HarnessQualificationRegistry(f.reader.repository, { codex: mount.revision })
        expect(await gate.trustedExact('codex', '0.132.0', 'a'.repeat(64))).toBe(true)
        f.facts.harness.qualification.suiteRevision = 'codex-live-4'
        await expect(f.reader.capture()).rejects.toMatchObject({ code: 'HARNESS_UNQUALIFIED' })
      } finally { await worker.stop() }
    } finally { await rm(stateDirectory, { recursive: true, force: true }) }
  })
  it('reads the exact persisted record afresh for every allocation and readonly repository lookup', async () => {
    const f = fixture()
    expect((await f.reader.capture()).qualification).toEqual(f.facts.harness.qualification)
    expect(await f.reader.repository.find('codex', '0.132.0', 'a'.repeat(64), 'codex-live-4')).toEqual(f.facts.harness.qualification)
    expect(await f.reader.repository.find('codex', '0.154.0', 'a'.repeat(64), 'codex-live-4')).toBeNull()
    expect(f.readFacts).toHaveBeenCalledTimes(3)
    expect(f.inspect).toHaveBeenCalledTimes(6)
    f.facts.harness.qualification.status = 'unqualified'
    await expect(f.reader.repository.list()).rejects.toMatchObject({ code: 'HARNESS_UNQUALIFIED' })
  })
  it.each(['proof-absent', 'wrong-sha', 'wrong-suite', 'wrong-profile', 'failed-check', 'stale-profile', 'different-operation', 'foreign-host', 'wrong-configuration'] as const)('denies %s without using a baseline or config trust flag', async kind => {
    const f = fixture()
    if (kind === 'proof-absent') f.facts.harness.qualification.status = 'unqualified'
    if (kind === 'wrong-sha') f.facts.harness.qualification.binarySha256 = 'c'.repeat(64)
    if (kind === 'wrong-suite') f.facts.harness.qualification.suiteRevision = 'previous-suite'
    if (kind === 'wrong-profile') f.facts.harness.qualification.profile = 'codex-0.154'
    if (kind === 'failed-check') f.facts.harness.qualification.checks[0]!.passed = false
    if (kind === 'stale-profile') f.facts.harness.profileProof.instanceRevision = 'new-revision'
    if (kind === 'different-operation') f.readFacts.mockImplementation(async () => ({ ...structuredClone(f.facts), intent: { ...f.facts.intent, operationId: 'another-operation' } }))
    if (kind === 'foreign-host') f.facts.harness.override.target.applicationInstallationId = randomUUID()
    if (kind === 'wrong-configuration') f.facts.configuration.harness = { ...DEFAULT_HARNESS_DEFAULTS.codex, model: 'another-model' }
    await expect(f.reader.capture()).rejects.toMatchObject({ code: 'HARNESS_UNQUALIFIED' })
  })
  it('rejects channel replacement, key revocation and local file replacement across the Main await', async () => {
    for (const field of ['connectionEpoch', 'bootId', 'keyRevision', 'authorizationRevision', 'workerInstallationId'] as const) {
      const f = fixture()
      f.readFacts.mockImplementation(async () => { f.setLive({ ...f.binding, [field]: typeof f.binding[field] === 'number' ? 99 : randomUUID() }); return structuredClone(f.facts) })
      await expect(f.reader.capture()).rejects.toMatchObject({ code: 'HARNESS_UNQUALIFIED' })
    }
    const f = fixture()
    f.inspect.mockImplementationOnce(async () => structuredClone(f.inspection)).mockImplementation(async () => ({ ...structuredClone(f.inspection), currentTarget: { ...f.inspection.currentTarget!, binarySha256: 'c'.repeat(64) } }))
    await expect(f.reader.capture()).rejects.toMatchObject({ code: 'HARNESS_UNQUALIFIED' })
  })
  it('fails closed on disconnected or cancelled authority before file inspection', async () => {
    const f = fixture()
    f.setLive(null)
    await expect(f.reader.capture()).rejects.toMatchObject({ code: 'HARNESS_UNQUALIFIED' })
    expect(f.inspect).not.toHaveBeenCalled()
    f.setLive(f.binding); f.controller.abort()
    await expect(f.reader.capture()).rejects.toBeDefined()
    expect(f.inspect).not.toHaveBeenCalled()
  })
})

it('reads a renewed execution owner without admitting a different operation or configuration', async () => {
  const f = fixture({ harness: 'codex' })
  const originalIntent = structuredClone(f.facts.intent)
  const reader = createInstalledCodexQualificationReader({ intent: originalIntent,
    placement: f.facts.placement, trustedCurrentBinding: () => f.binding,
    trustedCurrentIntent: () => f.facts.intent, inspect: f.inspect, readFacts: f.readFacts,
    suiteRevision: 'codex-live-4', signal: f.controller.signal })
  await reader.capture()
  f.facts.intent.owner = { grantId: 'renewed-original-execution-grant', epoch: '2' }
  expect((await reader.capture()).facts.intent.owner).toEqual(f.facts.intent.owner)
  f.facts.intent.operationId = 'replacement-operation'
  await expect(reader.capture()).rejects.toMatchObject({ code: 'HARNESS_UNQUALIFIED' })
})
