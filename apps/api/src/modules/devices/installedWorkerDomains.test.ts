import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { WorkerPairingConfigurationSchema } from '@graphql/contracts/device-identity'
import { createInstalledWorkerDomains } from './installedWorkerDomains.js'

describe('actual installed worker mount availability, no physical acceptance', () => {
  it('keeps native/source/CI domains unavailable without protected approved roots', async () => {
    const pairing = WorkerPairingConfigurationSchema.parse({ formatVersion: 1, mainId: randomUUID(), deviceId: randomUUID(),
      workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1, endpoint: 'wss://unconnected.example/device/connect',
      mainPublicKeyFingerprint: 'a'.repeat(64), credential: 'b'.repeat(64), expiresAt: new Date(Date.now() + 60_000).toISOString() })
    const mounted = await createInstalledWorkerDomains({ stateDirectory: '/uncreated-model-free-fixture', pairing, bootId: randomUUID(),
      configuration: null, approvedRoots: async () => null, connection: () => undefined, codexSuiteRevision: 'source-test-current-suite' })
    expect(mounted.workflowAvailable).toBe(false)
    expect(mounted.sourceAvailable).toBe(false)
    expect(mounted.extensions.map(extension => extension.namespace)).toEqual(['harness-discovery-v1'])
    await mounted.close(); await mounted.close()
  })
})
