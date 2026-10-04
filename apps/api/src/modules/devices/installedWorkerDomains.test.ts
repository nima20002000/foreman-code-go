import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkerPairingConfigurationSchema } from '@graphql/contracts/device-identity'
import { createInstalledWorkerDomains } from './installedWorkerDomains.js'
import { ApprovedRootAllowlistSchema } from '@graphql/contracts/workspace-root-policies'
import { extensionDescriptors } from './deviceApplicationChannel.js'
import { bootIdentity } from '../harnesses/recovery/linuxIdentity.js'

describe('actual installed worker mount availability, no physical acceptance', () => {
  it('mounts the guarded native profile-check endpoint for an installed workflow configuration', async () => {
    const stateDirectory = await mkdtemp('/var/tmp/worker-profile-check-')
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
      managedRuntimeRoot: '/uncreated/runtime', runtimeFilesystem: filesystem })
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
    expect(mounted.extensions.map(extension => extension.namespace)).toEqual(['harness-discovery-v1'])
    await mounted.close(); await mounted.close()
  })
  it('advertises the actual Job input client on the existing channel only with an explicit Job installation',async()=>{
    const pairing=WorkerPairingConfigurationSchema.parse({formatVersion:1,mainId:randomUUID(),deviceId:randomUUID(),workerInstallationId:randomUUID(),
      keyRevision:1,authorizationRevision:1,endpoint:'wss://unconnected.example/device/connect',mainPublicKeyFingerprint:'a'.repeat(64),credential:'b'.repeat(64),expiresAt:new Date(Date.now()+60000).toISOString()})
    // Metadata negotiation fixture only. No path is created and no qualification is supplied.
    const filesystem={device:'1',inode:'1',mountId:'1'}
    const approved=ApprovedRootAllowlistSchema.parse({schemaVersion:1,hostRef:{kind:'device',mainId:pairing.mainId,deviceId:pairing.deviceId},applicationInstallationId:pairing.workerInstallationId,
      configurationRevision:'1',bases:[{baseId:randomUUID(),canonicalPath:'/uncreated-input-client-root',filesystem,accessModes:['read-write']}],
      managedRuntimeRoot:'/uncreated-input-client-runtime',runtimeFilesystem:filesystem})
    const input={stateDirectory:'/uncreated-input-client-state',pairing,bootId:randomUUID(),configuration:null,approvedRoots:async()=>approved,
      connection:()=>undefined,codexSuiteRevision:'source-test-current-suite'}
    const absent=await createInstalledWorkerDomains(input)
    expect(absent.extensions.some(value=>value.namespace==='job-inputs-v1')).toBe(false)
    await absent.close()
    const configured=await createInstalledWorkerDomains({...input,jobConfiguration:{path:'/uncreated-job-selection.json',ownerUid:process.getuid!()}})
    expect(extensionDescriptors(configured.extensions).filter(value=>value.namespace==='job-inputs-v1')).toEqual([{namespace:'job-inputs-v1',version:1,role:'client',maxJsonBytes:1_048_576,maxBinaryBytes:8192}])
    expect(extensionDescriptors(configured.extensions).filter(value => value.namespace === 'byte-transfer-v1'))
      .toEqual([{ namespace: 'byte-transfer-v1', version: 1, role: 'duplex', maxJsonBytes: 16384, maxBinaryBytes: 1048576 }])
    await configured.close()
  })
})
