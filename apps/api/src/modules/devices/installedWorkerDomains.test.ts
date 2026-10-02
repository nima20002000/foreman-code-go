import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { WorkerPairingConfigurationSchema } from '@graphql/contracts/device-identity'
import { createInstalledWorkerDomains } from './installedWorkerDomains.js'
import { ApprovedRootAllowlistSchema } from '@graphql/contracts/workspace-root-policies'
import { extensionDescriptors } from './deviceApplicationChannel.js'

describe('actual installed worker mount availability, no physical acceptance', () => {
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
    await configured.close()
  })
})
