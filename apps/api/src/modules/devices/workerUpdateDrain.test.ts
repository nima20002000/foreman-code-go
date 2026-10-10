import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { WorkerPairingConfigurationSchema } from '@foreman-code/contracts/device-identity'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { workerConversationFixture } from '../conversations/workerFixtures.test-support.js'
import { RemoteOperationJournal } from '../runs/remote/operationJournal.js'
import { createInstalledWorkerDomains } from './installedWorkerDomains.js'

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
