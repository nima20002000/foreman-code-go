import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { ApprovedRootAllowlist } from '@graphql/contracts/workspace-root-policies'
import { WorkerPairingConfigurationSchema } from '@graphql/contracts/device-identity'
import type { RemoteOperationJournal } from '../runs/remote/operationJournal.js'

const ports = vi.hoisted(() => ({ qualification: vi.fn(), open: vi.fn(), close: vi.fn() }))
vi.mock('../jobs/workerQualificationCarrier.js', () => ({ createWorkerQualificationExtension: ports.qualification }))
vi.mock('../runs/remote/operationJournal.js', () => ({ RemoteOperationJournal: { open: ports.open } }))
vi.mock('../runs/remote/installedWorkflowHost.js', () => ({ createInstalledWorkflowHost: async () => ({ kind: 'unavailable' }) }))
import { createInstalledWorkerDomains } from './installedWorkerDomains.js'

describe('original installed Job qualification composition, no native entry', () => {
  it('opens the established Job journal and closes it once without borrowing workflow ownership', async () => {
    const pairing = WorkerPairingConfigurationSchema.parse({ formatVersion: 1, mainId: randomUUID(), deviceId: randomUUID(),
      workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1, endpoint: 'wss://unconnected.example/device/connect',
      mainPublicKeyFingerprint: 'a'.repeat(64), credential: 'b'.repeat(64), expiresAt: new Date(Date.now() + 60_000).toISOString() })
    ports.qualification.mockReturnValue({ namespace: 'job-runtime-qualification-v1', version: 1, role: 'duplex', maxJsonBytes: 1, maxBinaryBytes: 0 })
    ports.open.mockResolvedValue({ close: ports.close } as unknown as RemoteOperationJournal)
    const mounted = await createInstalledWorkerDomains({ stateDirectory: '/original-worker-state', pairing, bootId: randomUUID(),
      configuration: null, jobConfiguration: { path: '/original-worker-state/job-runtime.json', ownerUid: 1000 },
      // This test exercises composition only; the injected host never parses or uses root authority.
      approvedRoots: async () => ({} as ApprovedRootAllowlist), connection: () => undefined, codexSuiteRevision: 'source-test-suite' })
    const qualification = ports.qualification.mock.calls[0]![0] as { journal(): Promise<RemoteOperationJournal>; registry: { snapshot(): unknown } }
    const journal = await qualification.journal()
    expect(await qualification.journal()).toBe(journal)
    expect(ports.open).toHaveBeenCalledExactlyOnceWith('/original-worker-state/job-runtime-operations.json')
    expect(qualification.registry.snapshot()).toMatchObject({ launches: [] })
    await mounted.close(); await mounted.close()
    expect(ports.close).toHaveBeenCalledTimes(1)
  })
})
