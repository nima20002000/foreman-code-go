import { persistentFixtureRoot } from '../../../test/helpers/fixtureStorage.js'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkerPairingConfigurationSchema } from '@foreman-code/contracts/device-identity'
import { createInstalledWorkerDomains, createWorkerRuntimeDrain } from './installedWorkerDomains.js'
import { ApprovedRootAllowlistSchema } from '@foreman-code/contracts/workspace-root-policies'
import { extensionDescriptors } from './deviceApplicationChannel.js'
import { bootIdentity } from '../harnesses/recovery/linuxIdentity.js'
import { afterEach } from 'vitest'
import { RemoteOperationJournal } from '../runs/remote/operationJournal.js'
import { TelemetryCollectedBatchSchema } from '@foreman-code/contracts/resource-telemetry'
import { resourceTelemetryExtension } from '../resource-telemetry/ingestion/ports.js'
import { SourceRootRecordSchema } from '@foreman-code/contracts/source-admission'
import { qualifyApprovedRootAllowlist } from '../sources/rootAttestation.js'
import { identity, openPrivateRoot } from '../sources/privateFilesystem.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('actual installed worker mount availability, no physical acceptance', () => {
  it('drains active Jobs and Agent sessions before refresh while preserving status and controls', async () => {
    let finishJob!: () => void
    const job = new Promise<void>(resolve => { finishJob = resolve })
    let agentOpen = true
    let jobOutcome = 'running'
    let scheduled = false
    const drain = createWorkerRuntimeDrain({ signal: new AbortController().signal, active: () => [],
      drainJobs: async () => { await job; jobOutcome = 'succeeded' },
      drainQualifications: async () => {}, quiescent: async () => !agentOpen })
    const refresh = drain.run().then(() => { scheduled = true })
    expect(() => drain.assertAdmission('execution-v1', { method: 'job-dispatch' })).toThrow('waiting for active work')
    expect(() => drain.assertAdmission('execution-v1', { method: 'conversation.open' })).toThrow()
    expect(() => drain.assertAdmission('job-runtime-qualification-v1', { operation: 'start' })).toThrow()
    expect(() => drain.assertAdmission('harness-discovery-v1', {})).toThrow()
    expect(() => drain.assertAdmission('execution-v1', { method: 'job-status' })).not.toThrow()
    expect(() => drain.assertAdmission('execution-v1', { method: 'conversation.close' })).not.toThrow()
    expect(() => drain.assertAdmission('execution-v1', { method: 'conversation.respond' })).not.toThrow()
    expect(scheduled).toBe(false)
    expect(jobOutcome).toBe('running')
    finishJob()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(jobOutcome).toBe('succeeded')
    expect(scheduled).toBe(false)
    agentOpen = false
    await refresh
    expect(scheduled).toBe(true)
    expect(jobOutcome).toBe('succeeded')
    drain.resume()
    expect(() => drain.assertAdmission('execution-v1', { method: 'job-dispatch' })).not.toThrow()
  })

  it('recovers an unused source reservation from protected journals without native runtime selections', async () => {
    const stateDirectory = await mkdtemp(join(persistentFixtureRoot, 'worker-source-cleanup-'))
    roots.push(stateDirectory)
    const project = join(stateDirectory, 'project')
    const rootPolicyId = randomUUID()
    const namespace = join(stateDirectory, 'source-materializations', rootPolicyId)
    await mkdir(project, { mode: 0o700 })
    await mkdir(namespace, { recursive: true, mode: 0o700 })
    for (const name of ['workflow-operations.json', 'job-runtime-operations.json']) {
      const journal = await RemoteOperationJournal.open(join(stateDirectory, name), { initializeNewInstallation: true })
      await journal.close()
    }
    const pairing = WorkerPairingConfigurationSchema.parse({ formatVersion: 1, mainId: randomUUID(), deviceId: randomUUID(),
      workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1, endpoint: 'wss://unconnected.example/device/connect',
      mainPublicKeyFingerprint: 'a'.repeat(64), credential: 'b'.repeat(64), expiresAt: new Date(Date.now() + 60_000).toISOString() })
    const approved = await qualifyApprovedRootAllowlist({ schemaVersion: 1,
      hostRef: { kind: 'device', mainId: pairing.mainId, deviceId: pairing.deviceId },
      applicationInstallationId: pairing.workerInstallationId, configurationRevision: '1',
      bases: [{ baseId: randomUUID(), canonicalPath: project, accessModes: ['read-write'] }],
      managedRuntimeRoot: stateDirectory })
    const directory = await openPrivateRoot(namespace)
    const filesystem = await identity(directory)
    await directory.close()
    const source = { approvedSourceId: randomUUID(), snapshotId: randomUUID(), manifestDigest: 'c'.repeat(64) }
    const root = SourceRootRecordSchema.parse({ version: 1, source,
      selection: { hostRef: approved.hostRef, rootPolicyId, rootPolicyRevision: '1', locationRevision: '1' },
      binding: { version: 1, mainId: pairing.mainId, deviceId: pairing.deviceId,
        workerInstallationId: pairing.workerInstallationId, workspaceId: randomUUID(), rootId: randomUUID(),
        bindingRevision: 1, locationRevision: 1, canonicalPath: namespace, filesystem, accessMode: 'exclusive-write',
        snapshotId: source.snapshotId, manifestDigest: source.manifestDigest },
      registration: { workerInstallationId: pairing.workerInstallationId, keyRevision: 1, authorizationRevision: 1 },
      ownerPrincipalId: 'source-owner', authorizedByPrincipalId: 'source-owner', attestationId: randomUUID(),
      attestationDigest: 'd'.repeat(64), boundAt: new Date().toISOString() })
    const grant = { reservationId: randomUUID(), reclamationId: randomUUID(), operationId: randomUUID(),
      scopeId: 'original-filesystem', expiresAt: pairing.expiresAt, roots: [root], owner: null }
    const binding = { mainId: pairing.mainId, deviceId: pairing.deviceId, workerInstallationId: pairing.workerInstallationId,
      keyRevision: 1, authorizationRevision: 1, bootId: bootIdentity(), connectionEpoch: randomUUID(), connectionGeneration: 1 }
    const mounted = await createInstalledWorkerDomains({ stateDirectory, pairing, bootId: binding.bootId,
      configuration: null, approvedRoots: async () => approved, codexSuiteRevision: 'fixture-suite',
      connection: () => ({ currentBinding: () => binding, captureRequest: () => ({ binding,
        request: async () => ({ payload: { version: 1, operation: 'sources.reclamation-authorize', grant } }) }) }) })
    try {
      const extension = mounted.extensions.find(value => value.namespace === 'source-operations-v1')!
      expect(await extension.handle!({ version: 1, operation: 'sources.reclaim-reservation',
        reservationId: grant.reservationId, reclamationId: grant.reclamationId },
      { binding, signal: AbortSignal.timeout(10_000) }))
        .toMatchObject({ payload: { reclaimed: true, operationId: grant.operationId, closures: [] } })
    } finally {
      await mounted.close()
    }
  }, 30_000)
  it('mounts the guarded native profile-check endpoint for an installed workflow configuration', async () => {
    const stateDirectory = await mkdtemp(join(persistentFixtureRoot, 'worker-profile-check-'))
    const journal = await RemoteOperationJournal.open(join(stateDirectory, 'workflow-operations.json'),
      { initializeNewInstallation: true })
    await journal.close()
    const pairing = WorkerPairingConfigurationSchema.parse({ formatVersion: 1, mainId: randomUUID(), deviceId: randomUUID(),
      workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1, endpoint: 'wss://unconnected.example/device/connect',
      mainPublicKeyFingerprint: 'a'.repeat(64), credential: 'b'.repeat(64), expiresAt: new Date(Date.now() + 60000).toISOString() })
    const path = join(stateDirectory, 'workflow-runtime.json')
    await writeFile(path, JSON.stringify({ schemaVersion: 1, codexBinary: '/uncreated/codex',
      appMcpLauncher: '/uncreated/launcher.mjs', expectedVersion: '0.154.0', payloadPaths: [] }), { mode: 0o600 })
    const filesystem = { device: '1', inode: '1', mountId: '1' }
    const approved = ApprovedRootAllowlistSchema.parse({ schemaVersion: 1,
      hostRef: { kind: 'device', mainId: pairing.mainId, deviceId: pairing.deviceId },
      applicationInstallationId: pairing.workerInstallationId, configurationRevision: '1',
      bases: [{ baseId: randomUUID(), canonicalPath: '/uncreated/project', filesystem, accessModes: ['read-write'] }],
      managedRuntimeRoot: stateDirectory, runtimeFilesystem: filesystem })
    const mounted = await createInstalledWorkerDomains({ stateDirectory, pairing, bootId: bootIdentity(),
      configuration: { path, ownerUid: process.getuid!() }, approvedRoots: async () => approved,
      connection: () => undefined, codexSuiteRevision: 'fixture-suite' })
    try {
      expect(extensionDescriptors(mounted.extensions).filter(value => value.namespace === 'host-harness-check-v1'))
        .toEqual([{ namespace: 'host-harness-check-v1', version: 1, role: 'server', maxJsonBytes: 1048576, maxBinaryBytes: 0 }])
      const handler = mounted.extensions.find(value => value.namespace === 'host-harness-check-v1')!
      await expect(handler.handle!({}, { signal: AbortSignal.timeout(1000), binding: {
        mainId: pairing.mainId, deviceId: pairing.deviceId, workerInstallationId: pairing.workerInstallationId,
        keyRevision: 1, authorizationRevision: 1, bootId: randomUUID(), connectionEpoch: randomUUID(), connectionGeneration: 1,
      } })).rejects.toThrow()
    } finally {
      await mounted.close()
      await rm(stateDirectory, { recursive: true, force: true })
    }
  })
  it('keeps native/source/CI domains unavailable without protected approved roots', async () => {
    const pairing = WorkerPairingConfigurationSchema.parse({ formatVersion: 1, mainId: randomUUID(), deviceId: randomUUID(),
      workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1, endpoint: 'wss://unconnected.example/device/connect',
      mainPublicKeyFingerprint: 'a'.repeat(64), credential: 'b'.repeat(64), expiresAt: new Date(Date.now() + 60_000).toISOString() })
    const mounted = await createInstalledWorkerDomains({ stateDirectory: '/uncreated-model-free-fixture', pairing, bootId: randomUUID(),
      configuration: null, approvedRoots: async () => null, connection: () => undefined, codexSuiteRevision: 'source-test-current-suite' })
    expect(mounted.workflowAvailable).toBe(false)
    expect(mounted.sourceAvailable).toBe(false)
    expect(mounted.rsyncAvailable).toBe(false)
    expect(mounted.rsyncMissing).toContain('canonical acknowledgement')
    expect(mounted.extensions.map(extension => extension.namespace).sort()).toEqual(['agent-snapshot-v1', 'computer-accounts-v1', 'computer-drive-v2', 'computer-github-v1', 'harness-discovery-v1'])
    await mounted.close(); await mounted.close()
  })
  it('advertises the actual Job input client on the existing channel only with an explicit Job installation',async()=>{
    const pairing=WorkerPairingConfigurationSchema.parse({formatVersion:1,mainId:randomUUID(),deviceId:randomUUID(),workerInstallationId:randomUUID(),
      keyRevision:1,authorizationRevision:1,endpoint:'wss://unconnected.example/device/connect',mainPublicKeyFingerprint:'a'.repeat(64),credential:'b'.repeat(64),expiresAt:new Date(Date.now()+60000).toISOString()})
    const stateDirectory = await mkdtemp(join(persistentFixtureRoot, 'worker-input-client-'))
    roots.push(stateDirectory)
    const journal = await RemoteOperationJournal.open(join(stateDirectory, 'job-runtime-operations.json'),
      { initializeNewInstallation: true })
    await journal.close()
    // Metadata negotiation fixture only; original journal storage is real.
    const filesystem={device:'1',inode:'1',mountId:'1'}
    const approved=ApprovedRootAllowlistSchema.parse({schemaVersion:1,hostRef:{kind:'device',mainId:pairing.mainId,deviceId:pairing.deviceId},applicationInstallationId:pairing.workerInstallationId,
      configurationRevision:'1',bases:[{baseId:randomUUID(),canonicalPath:'/uncreated-input-client-root',filesystem,accessModes:['read-write']}],
      managedRuntimeRoot:stateDirectory,runtimeFilesystem:filesystem})
    const bootId = bootIdentity()
    const binding = { mainId: pairing.mainId, deviceId: pairing.deviceId, workerInstallationId: pairing.workerInstallationId,
      keyRevision: 1, authorizationRevision: 1, bootId, connectionEpoch: randomUUID(), connectionGeneration: 1 }
    const input={stateDirectory,pairing,bootId,configuration:null,approvedRoots:async()=>approved,
      connection:()=>({ currentBinding:()=>binding, captureRequest:()=>undefined }),codexSuiteRevision:'source-test-current-suite'}
    const absent=await createInstalledWorkerDomains(input)
    expect(absent.extensions.some(value=>value.namespace==='job-inputs-v1')).toBe(false)
    expect(extensionDescriptors(absent.extensions).filter(value => value.namespace === 'byte-transfer-v1'))
      .toEqual([{ namespace: 'byte-transfer-v1', version: 1, role: 'duplex', maxJsonBytes: 16384, maxBinaryBytes: 1048576 }])
    expect(absent.extensions.some(value => value.namespace === resourceTelemetryExtension.namespace)).toBe(false)
    await absent.close()
    const configured=await createInstalledWorkerDomains({...input,jobConfiguration:{path:'/uncreated-job-selection.json',ownerUid:process.getuid!()}})
    expect(extensionDescriptors(configured.extensions).filter(value=>value.namespace==='job-inputs-v1')).toEqual([{namespace:'job-inputs-v1',version:1,role:'client',maxJsonBytes:1_048_576,maxBinaryBytes:8192}])
    expect(extensionDescriptors(configured.extensions).filter(value => value.namespace === 'byte-transfer-v1'))
      .toEqual([{ namespace: 'byte-transfer-v1', version: 1, role: 'duplex', maxJsonBytes: 16384, maxBinaryBytes: 1048576 }])
    try {
      const telemetry = configured.extensions.find(value => value.namespace === resourceTelemetryExtension.namespace)!
      const identity = { mainId: pairing.mainId, host: { hostRef: approved.hostRef, deviceId: pairing.deviceId,
        applicationInstallationId: pairing.workerInstallationId, bootId, runtimeEpoch: binding.connectionEpoch,
        keyRevision: 1, authorizationRevision: 1, connectionGeneration: 1, collectorGeneration: 'installed-controller' } }
      const now = Date.now()
      const payload = { operation: 'collect', challenge: { schemaVersion: 1, identity, challengeId: randomUUID(),
        issuedAtUnixMs: now, freshUntilUnixMs: now + 5000 } }
      const context = { binding, signal: AbortSignal.timeout(5000) }
      const result = await telemetry.handle!(payload, context)
      const batch = TelemetryCollectedBatchSchema.parse(result.payload)
      expect(batch.identity).toEqual(identity)
      expect(batch.host?.memory).toMatchObject({ state: 'ok', value: { kind: 'host-used-estimate' } })
      if (batch.host?.memory.state !== 'ok' || !('availableBytes' in batch.host.memory.value)) throw new Error('Host memory unavailable')
      expect(batch.host.memory.value.availableBytes).toBeGreaterThan(0)
      const totalBytes = batch.host.memory.value.totalBytes
      if (totalBytes === null) throw new Error('Host memory total unavailable')
      expect(batch.host.memory.value.availableBytes).toBeLessThanOrEqual(totalBytes)
      await expect(telemetry.handle!({ ...payload, challenge: { ...payload.challenge,
        challengeId: randomUUID(), identity: { ...identity, host: { ...identity.host, bootId: randomUUID() } } } }, context))
        .rejects.toThrow()
    } finally { await configured.close() }
  })
})
