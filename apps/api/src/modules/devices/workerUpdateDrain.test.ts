import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import { WorkerPairingConfigurationSchema } from '@foreman-code/contracts/device-identity'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { workerConversationFixture } from '../conversations/workerFixtures.test-support.js'
import { RemoteOperationJournal } from '../runs/remote/operationJournal.js'
import { createInstalledWorkerDomains } from './installedWorkerDomains.js'
import { persistentFixtureRoot } from '../../../test/helpers/fixtureStorage.js'
import { qualifyApprovedRootAllowlist } from '../sources/rootAttestation.js'
import { ResumableByteTransferService } from '../byte-transfer/service.js'
import { transferContextForBinding } from '../byte-transfer/carrier.js'
import { bootIdentity } from '../harnesses/recovery/linuxIdentity.js'
import { HostCiRunner } from '../ci-host/runner.js'
import type { TransferIntent } from '@foreman-code/contracts/byte-transfer'

it('waits for uncertain native conversation work without treating an idle open session as active update work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'worker-update-journal-'))
  const store = await RemoteOperationJournal.open(join(directory, 'operations.json'), { initializeNewInstallation: true })
  try {
    const f = workerConversationFixture()
    await store.conversations.receive(f.binding, f.connection)
    await store.conversations.reserveCreation(f.binding, 'create', commandInputHash('create'))
    await store.conversations.bindSession(f.binding, f.session, f.nativeOwner)
    expect(await store.isRuntimeQuiescent()).toBe(false)
    expect(await store.isWorkerUpdateIdle()).toBe(true)
    await store.conversations.reserveTurn(f.binding, 'turn', commandInputHash('turn'))
    expect(await store.isWorkerUpdateIdle()).toBe(false)
    await store.conversations.submitted(f.binding, 'turn', { nativeTurnId: 'native-turn' })
    await store.conversations.finishTurn(f.binding, 'turn')
    expect(await store.isWorkerUpdateIdle()).toBe(false)
    await store.conversations.finishTurn(f.binding, 'turn', { outcome: 'succeeded' })
    expect(await store.isWorkerUpdateIdle()).toBe(true)
    const compact = await store.conversations.reserveCompact(f.binding, 'compact', commandInputHash('compact'))
    expect(await store.isWorkerUpdateIdle()).toBe(false)
    await store.conversations.compactProgress(f.binding, { ...compact.state, status: 'completed' })
    expect(await store.isWorkerUpdateIdle()).toBe(true)
    expect((await store.conversations.read(f.binding))?.turns[0]?.result).toEqual({ outcome: 'succeeded' })
    expect(await store.isRuntimeQuiescent()).toBe(false)
  } finally {
    await store.close()
    await rm(directory, { recursive: true, force: true })
  }
})

it('mounts update admission draining even when no job or workflow runtime is configured', async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'worker-update-domains-'))
  const pairing = WorkerPairingConfigurationSchema.parse({ formatVersion: 1, mainId: randomUUID(),
    deviceId: randomUUID(), workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1,
    endpoint: 'wss://unconnected.example/device/connect', mainPublicKeyFingerprint: 'a'.repeat(64),
    credential: 'b'.repeat(64), expiresAt: '2099-01-01T00:00:00Z' })
  const binding = { mainId: pairing.mainId, deviceId: pairing.deviceId,
    workerInstallationId: pairing.workerInstallationId, bootId: randomUUID(), keyRevision: 1,
    authorizationRevision: 1, connectionEpoch: randomUUID(), connectionGeneration: 1 }
  const domains = await createInstalledWorkerDomains({ stateDirectory, pairing, bootId: binding.bootId,
    configuration: null, approvedRoots: async () => null, codexSuiteRevision: 'fixture',
    connection: () => ({ currentBinding: () => binding, mainNow: () => Date.now(), captureRequest: () => undefined }) })
  try {
    await domains.drainForUpdate()
    const extension = domains.extensions.find(extension => extension.namespace === 'harness-discovery-v1')!
    await expect(extension.handle!({}, { binding, signal: AbortSignal.timeout(1000) }))
      .rejects.toMatchObject({ code: 'WORKER_RUNTIME_DRAINING' })
    domains.resumeAfterUpdate()
  } finally {
    await domains.close()
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

it('rejects Host CI and accepted rsync writer starts after drain while keeping controls available', async () => {
  const stateDirectory = await mkdtemp(join(persistentFixtureRoot, 'worker-drain-controls-'))
  const project = join(stateDirectory, 'project')
  const stagingRoot = join(stateDirectory, 'staging')
  await mkdir(project, { mode: 0o700 })
  await mkdir(stagingRoot, { mode: 0o700 })
  const pairing = WorkerPairingConfigurationSchema.parse({ formatVersion: 1, mainId: randomUUID(),
    deviceId: randomUUID(), workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1,
    endpoint: 'wss://unconnected.example/device/connect', mainPublicKeyFingerprint: 'a'.repeat(64),
    credential: 'b'.repeat(64), expiresAt: '2099-01-01T00:00:00Z' })
  const binding = { mainId: pairing.mainId, deviceId: pairing.deviceId,
    workerInstallationId: pairing.workerInstallationId, bootId: bootIdentity(), keyRevision: 1,
    authorizationRevision: 1, connectionEpoch: randomUUID(), connectionGeneration: 1 }
  const approved = await qualifyApprovedRootAllowlist({ schemaVersion: 1,
    hostRef: { kind: 'device', mainId: pairing.mainId, deviceId: pairing.deviceId },
    applicationInstallationId: pairing.workerInstallationId, configurationRevision: '1',
    bases: [{ baseId: randomUUID(), canonicalPath: project, accessModes: ['read-write'] }],
    managedRuntimeRoot: stateDirectory })
  const intent: TransferIntent = { ...transferContextForBinding(binding), version: 1,
    transferId: randomUUID(), operationId: randomUUID(), executionId: randomUUID(), attemptId: randomUUID(),
    placementHash: 'a'.repeat(64), rootId: randomUUID(), rootBindingRevision: 1, direction: 'to-worker',
    byteClass: 'source', sha256: 'b'.repeat(64), byteSize: 8, manifestDigest: 'c'.repeat(64), chunkBytes: 8,
    expiresAt: new Date(Date.now() + 60_000).toISOString() }
  const accepted = { intent: vi.fn(async () => intent), authorize: vi.fn(async () => {}) }
  const receiver = new ResumableByteTransferService(join(stateDirectory, 'canonical'), accepted)
  const executable = await realpath(process.execPath)
  const sha256 = createHash('sha256').update(await readFile(executable)).digest('hex')
  const domains = await createInstalledWorkerDomains({ stateDirectory, pairing, bootId: binding.bootId,
    configuration: null, approvedRoots: async () => approved, codexSuiteRevision: 'fixture',
    connection: () => ({ currentBinding: () => binding, mainNow: () => Date.now(), captureRequest: () => undefined }),
    rsync: { stagingRoot, accepted, receiver, binary: { executable, sha256 },
      resolveSource: async () => { throw new Error('No source reader selected') },
      acknowledged: async () => {}, quiescent: async () => {} } })
  const hostCi = vi.spyOn(HostCiRunner.prototype, 'handle')
  const frame = { binding, signal: AbortSignal.timeout(5000) }
  const ci = domains.extensions.find(extension => extension.namespace === 'ci-host-v1')!
  const rsync = domains.extensions.find(extension => extension.namespace === 'rsync-stage-v1')!
  const writer = (method: string) => ({ kind: 'rsync-stage-v1', method, transferId: intent.transferId })
  let finishPreparation!: () => void
  const preparation = new Promise<void>(resolve => { finishPreparation = resolve })
  try {
    await rsync.handle!(writer('writer-prepare'), frame)
    await rsync.handle!(writer('writer-stop'), frame)
    accepted.intent.mockClear()
    hostCi.mockImplementationOnce(async () => {
      await preparation
      throw new Error('CI preparation finished')
    })
    const starting = ci.handle!({ operation: 'start', runId: randomUUID(), repository: 'example/project',
      commit: 'd'.repeat(40), suite: 'unit' }, frame)
    const preparationFinished = expect(starting).rejects.toThrow('CI preparation finished')
    let drained = false
    const draining = domains.drainForUpdate().then(() => { drained = true })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(drained).toBe(false)
    finishPreparation()
    await preparationFinished
    await draining
    hostCi.mockRejectedValue(new Error('Host CI handler reached'))
    await expect(ci.handle!({ operation: 'start', runId: randomUUID(), repository: 'example/project',
      commit: 'd'.repeat(40), suite: 'unit' }, frame)).rejects.toMatchObject({ code: 'WORKER_RUNTIME_DRAINING' })
    for (const method of ['writer-prepare', 'writer-activate', 'receiver-prepare']) {
      await expect(rsync.handle!(writer(method), frame)).rejects.toMatchObject({ code: 'WORKER_RUNTIME_DRAINING' })
    }
    expect(domains.rsyncOwnership!.inventory()).toEqual([intent])
    expect(accepted.intent).not.toHaveBeenCalled()
    await expect(ci.handle!({ operation: 'status' }, frame)).rejects.toThrow('Host CI handler reached')
    await expect(ci.handle!({ operation: 'cancel', runId: randomUUID() }, frame))
      .rejects.toThrow('Host CI handler reached')
    for (const method of ['writer-status', 'writer-stop']) {
      expect((await rsync.handle!(writer(method), frame)).payload).toEqual(writer(method))
    }
    domains.resumeAfterUpdate()
    expect((await rsync.handle!(writer('writer-prepare'), frame)).payload).toMatchObject({ method: 'writer-prepare' })
    await rsync.handle!(writer('writer-stop'), frame)
  } finally {
    finishPreparation()
    hostCi.mockRestore()
    await domains.close()
    await receiver.close()
    await rm(stateDirectory, { recursive: true, force: true })
  }
})
