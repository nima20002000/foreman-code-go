import { describe, expect, it } from 'vitest'
import { ExecutionAuthorityRequestSchema } from '@graphql/contracts/execution-authority'
import { workerExecutionAuthorizer } from './executionAuthorityClient.js'
import { freezePlacement, deriveDispatch } from './binding.js'
import { SavedNodePlacementSchema } from '@graphql/contracts/node-placement'
const mainId='11111111-1111-4111-8111-111111111111', digest='a'.repeat(64)
const pin=freezePlacement({ schemaVersion:1,mainId,mainInstallationId:mainId,runId:'run',nodeId:'node',hostRef:{kind:'main',mainId},registration:null,
  destination:{canonicalProjectRoot:'/copies/root',canonicalCwd:'/copies/root',managedRuntimeRoot:'/native',directoryIdentityHash:digest,
    rootPolicyId:'policy',rootPolicyRevision:'1',locationRevision:'1',attestationId:'attestation',attestationHash:digest},
  source:{kind:'pending',approvedSourceId:mainId,snapshotId:mainId,revisionId:mainId,manifestDigest:digest,rootId:mainId,bindingRevision:1,materializationId:null,materializationDigest:null},
  payload:{kind:'agent',agentId:'agent',agentConfigurationVersionId:'config',driverId:'codex',driverRevision:'1',instanceId:'instance',instanceRevision:'1',harnessInstallationId:'harness',installationFingerprint:digest,runtimeContractVersion:1,protocolRevision:'1',credentialScopeRefs:[]} })
const intent=deriveDispatch(pin,{executionId:'execution',occurrenceId:null,occurrenceIndex:0,technicalAttempt:1,attemptId:'attempt',operationId:'operation',inputDigest:`sha256:${digest}`,owner:{grantId:'grant',epoch:'1'}})
describe('actual Agent admission contracts and private upstream authorizer',()=>{
  it('pins a deferred source without claiming a clone exists',()=>{expect(pin.source.materializationId).toBeNull();expect(ExecutionAuthorityRequestSchema.safeParse({version:1,action:'start',intent,placement:pin}).success).toBe(true)})
  it('rejects forged entry permits in an authority request',()=>{expect(ExecutionAuthorityRequestSchema.safeParse({version:1,action:'start',intent,placement:pin,permit:true}).success).toBe(false)})
  it('saves explicit approved source/root pins',()=>{expect(SavedNodePlacementSchema.parse({schemaVersion:1,hostRef:pin.hostRef,rootPolicyId:'policy',rootPolicyRevision:'1',locationRevision:'1',projectRoot:'/project',cwdPolicy:'project-root',relativeCwd:'',instanceId:'instance',instanceRevision:'1',harnessInstallationId:'harness',source:{approvedSourceId:mainId,snapshotId:mainId,manifestDigest:digest},rootBinding:{rootId:mainId,bindingRevision:1}}).source?.snapshotId).toBe(mainId)})
  it('uses only the authenticated namespace with exact echoed identities',async()=>{const authorize=workerExecutionAuthorizer(async(namespace,input)=>{expect(namespace).toBe('execution-authority-v1');expect(ExecutionAuthorityRequestSchema.parse(input).intent).toEqual(intent);return{payload:{version:1,action:'read',operationId:intent.operationId,attemptId:intent.attemptId,bindingHash:intent.bindingHash,owner:intent.owner}}});await authorize(intent,pin,'read')})
  it('rejects mismatched owner and binary authority responses',async()=>{const response={version:1,action:'start',operationId:intent.operationId,attemptId:intent.attemptId,bindingHash:intent.bindingHash,owner:intent.owner};await expect(workerExecutionAuthorizer(async()=>({payload:{...response,owner:{grantId:'forged',epoch:'1'}}}))(intent,pin,'start')).rejects.toThrow();await expect(workerExecutionAuthorizer(async()=>({payload:response,bytes:new Uint8Array([1])}))(intent,pin,'start')).rejects.toThrow()})
})
