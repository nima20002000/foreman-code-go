import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { jobSpecDigests } from '@graphql/contracts/jobs-node'
import { jobInputSnapshotDigest } from '@graphql/contracts/job-inputs-node'
import { JobBuildInputManifestSchema } from '@graphql/contracts/job-inputs'
import { jobExecution } from '../../../../test/helpers/jobFixture.js'
import { jobSupervisorIdentity, type QualifiedJobProfile } from '../../jobs/executor.js'
import { PodmanJobSupervisor, type PodmanCommandRunner } from '../../jobs/executorPodman.js'
import type { RemoteJobDispatchIntent } from '@graphql/contracts/remote-job-execution'
import { RemoteOperationJournal } from './operationJournal.js'
import { RemoteJobExecutionHost } from './jobExecutionHost.js'
const roots: string[] = [], journals: RemoteOperationJournal[] = [], hosts: RemoteJobExecutionHost[] = []
afterEach(async () => { await Promise.all(hosts.splice(0).map(host => host.drain())); await Promise.all(journals.splice(0).map(journal => journal.close())); await Promise.all(roots.splice(0).map(root => rm(root,{recursive:true,force:true}))) })
async function fixture(loseClosureAck = false, denyPublication = false, wrongInput = false, loseCollectionAck = false) {
  const root = await mkdtemp(join(tmpdir(),'w08-job-')); roots.push(root)
  const journal = await RemoteOperationJournal.open(join(root,'journal'),{initializeNewInstallation:true}); journals.push(journal)
  const execution = jobExecution()
  execution.acceptedSpec.target.destination.managedRuntimeRoot=join(root,'runtime');await mkdir(execution.acceptedSpec.target.destination.managedRuntimeRoot,{mode:0o700})
  Object.assign(execution.acceptedSpec,jobSpecDigests(execution.acceptedSpec,execution.acceptedSpec.workflowInput))
  const intent: RemoteJobDispatchIntent = { schemaVersion:1,protocolVersion:1,mainId:execution.acceptedSpec.target.mainId,
    subject:{kind:'manual-job',workspaceId:execution.workspaceId,jobExecutionId:execution.id,definitionId:execution.acceptedSpec.definitionId},executionId:execution.id,
    attemptId:execution.attemptId,operationId:execution.operationId,bindingHash:execution.acceptedSpec.bindingHash,inputDigest:`sha256:${execution.acceptedSpec.specDigest}`,owner:execution.owner }
  const state = { creates:0, collected:0, closureAccepted:false, reports:[] as string[], allowed:true }
  const cid='c'.repeat(64),policy=execution.acceptedSpec.policy
  const profile: QualifiedJobProfile = { policyId:policy.isolationPolicyId,policyRevision:policy.isolationPolicyRevision,imageDigest:policy.imageDigest,toolchainDigest:policy.toolchainDigest,
    runtimeVersion:'unit',ociRuntimeVersion:'unit',kernelVersion:'unit',qualificationId:'unit-qualified',rootless:true,cgroupV2:true,filesystemBounded:true,descendantContainment:true,network:'none',cpuLimit:1,memoryBytes:1048576,pidsLimit:64,diskBytes:1048576 }
  const runner: PodmanCommandRunner = { run:async argv => {
    if(argv.includes('create')){state.creates++;return{exitCode:0,stdout:cid}}
    if(argv[0]==='wait')return{exitCode:0,stdout:'7'}
    return{exitCode:0,stdout:JSON.stringify([{Id:cid,Config:{Labels:{'graphql.job.identity':jobSupervisorIdentity(execution),'graphql.job.spec':execution.acceptedSpec.specDigest,'graphql.job.attempt':execution.attemptId}},State:{Running:false,Pid:0,ExitCode:7,Status:'exited'}}])}
  },attach:()=>{const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough()});queueMicrotask(()=>{child.stdout.end('build exit7');child.stderr.end();child.emit('close',7)});return child as unknown as ReturnType<PodmanCommandRunner['attach']>} }
  const supervisor=new PodmanJobSupervisor(profile,runner)
  const host=new RemoteJobExecutionHost({journal,connection:{kind:'main',mainId:intent.mainId,mainInstallationId:execution.acceptedSpec.target.mainInstallationId,bootId:randomUUID()},incarnationId:randomUUID(),supervisor,
    source:{verify:async()=>({privateRepositoryRoot:execution.acceptedSpec.target.destination.canonicalProjectRoot,directoryIdentityHash:execution.acceptedSpec.target.destination.directoryIdentityHash,privateGit:true,diskQuotaBytes:1024})},
    inputs:{prepare:async current=>{
      const spec=current.acceptedSpec,hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex')
      const manifest=Buffer.from(JSON.stringify(JobBuildInputManifestSchema.parse({version:1,inputSnapshotDigest:jobInputSnapshotDigest(current),workflowInput:spec.workflowInput,files:[]}))),workflow=Buffer.from(JSON.stringify(spec.workflowInput))
      return {version:1,bindingId:'1'.repeat(64),recipient:{workspaceId:current.workspaceId,executionId:current.id,attemptId:wrongInput?'wrong':current.attemptId,operationId:current.operationId,owner:current.owner,bindingHash:spec.bindingHash,specDigest:spec.specDigest,materializationId:spec.source.materializationId,materializationDigest:spec.source.materializationDigest},inputSnapshotDigest:jobInputSnapshotDigest(current),manifestSha256:hash(manifest),manifestByteSize:manifest.length,directory:{relativePath:'.graphql-job-inputs',device:'1',inode:'2',mountId:'3'},files:[{relativePath:'manifest.json',sha256:hash(manifest),byteSize:manifest.length},{relativePath:'workflow-input.json',sha256:hash(workflow),byteSize:workflow.length}],readonlyMountRequired:true}
    }},
    authorize:async(_intent,_execution,action)=>{if(denyPublication&&action==='publish')throw new Error('cleanup cannot publish');if(!state.allowed)throw new Error('revoked')},appendLog:async()=>{},observeReceipt:async receipt=>{state.reports.push(`${receipt.phase}:${receipt.publication}`);if(loseCollectionAck&&receipt.publication==='collecting')throw new Error('lost collecting ACK');if(receipt.terminal){if(loseClosureAck)throw new Error('lost process ACK');state.closureAccepted=true}},
    collectOutputs:async()=>{expect(state.closureAccepted).toBe(true);state.collected++} });hosts.push(host)
  return {root,journal,execution,intent,state,host}
}
describe('actual OCI job adapter with command doubles, no installed runtime claim',()=>{
  it('runs one genuine manual job and commits physical exit before publication',async()=>{const f=await fixture();await f.host.deliver(f.intent,f.execution);await f.host.deliver(f.intent,f.execution);await f.host.drain();expect(f.state.creates).toBe(1);expect(f.state.collected).toBe(1);const status=await f.journal.jobStatus(f.intent.operationId);expect(status.status==='known'&&status.receipt.terminal?.exitCode).toBe(7);expect(status.status==='known'&&status.receipt.publication).toBe('complete');expect(f.state.reports[0]).toBe('confirmed_terminal:pending');expect(status.status==='known'&&status.receipt.intent.subject.kind).toBe('manual-job')})
  it('publication denial retains physical terminal and records failed output status',async()=>{const f=await fixture(false,true);await f.host.deliver(f.intent,f.execution);await f.host.drain();const status=await f.journal.jobStatus(f.intent.operationId);expect(status.status==='known'&&status.receipt.phase).toBe('confirmed_terminal');expect(status.status==='known'&&status.receipt.terminal?.exitCode).toBe(7);expect(status.status==='known'&&status.receipt.publication).toBe('failed');expect(f.state.collected).toBe(0);expect(f.state.reports.at(-1)).toBe('confirmed_terminal:failed')})
  it('lost collection ACK remains transport uncertainty without inventing output failure',async()=>{const f=await fixture(false,false,false,true);await f.host.deliver(f.intent,f.execution);await f.host.drain();const status=await f.journal.jobStatus(f.intent.operationId);expect(status.status==='known'&&status.receipt.terminal?.exitCode).toBe(7);expect(status.status==='known'&&status.receipt.publication).toBe('collecting');expect(f.state.collected).toBe(0)})
  it('changed accepted input tuple denies claim and native entry',async()=>{const f=await fixture(false,false,true);await f.host.deliver(f.intent,f.execution);await f.host.drain();const status=await f.journal.jobStatus(f.intent.operationId);expect(f.state.creates).toBe(0);expect(status.status==='known'&&status.receipt.entryAttempted).toBe(false);expect(status.status==='known'&&status.receipt.terminal?.outcome).toBe('preparation_failed')})
  it('lost main closure ACK retains pending publication and never reruns native work',async()=>{const f=await fixture(true);await f.host.deliver(f.intent,f.execution);await f.host.drain();await f.host.deliver(f.intent,f.execution);expect(f.state.creates).toBe(1);expect(f.state.collected).toBe(0);const status=await f.journal.jobStatus(f.intent.operationId);expect(status.status==='known'&&status.receipt.publication).toBe('pending');expect(status.status==='known'&&status.receipt.terminal?.processStopped).toBe(true)})
  it('denies wrong subject and revoked authority before any OCI start',async()=>{const f=await fixture();await expect(f.host.deliver({...f.intent,executionId:'fake-run'},f.execution)).rejects.toThrow('subject');f.state.allowed=false;await expect(f.host.deliver(f.intent,f.execution)).rejects.toThrow('revoked');expect(f.state.creates).toBe(0)})
  it('worker journal negative fence and restart retain original job identity',async()=>{const f=await fixture();await f.journal.jobAccept(f.intent,f.execution,{kind:'main',mainId:f.intent.mainId,mainInstallationId:f.execution.acceptedSpec.target.mainInstallationId,bootId:randomUUID()},randomUUID());await f.journal.jobControl({schemaVersion:1,protocolVersion:1,commandId:'stop',operationId:f.intent.operationId,attemptId:f.intent.attemptId,executionId:f.intent.executionId,bindingHash:f.intent.bindingHash,subject:f.intent.subject,owner:f.intent.owner,action:{kind:'stop'}});await f.journal.close();const recovered=await RemoteOperationJournal.open(join(f.root,'journal'));journals.push(recovered);expect((await recovered.jobReserveEntry(f.intent.operationId)).reserved).toBe(false);expect((await recovered.jobStatus(f.intent.operationId)).status).toBe('known');expect(f.state.creates).toBe(0)})
  it('spools exact log sequences in the same durable operation journal before main acknowledgment',async()=>{const f=await fixture();await f.journal.jobAccept(f.intent,f.execution,{kind:'main',mainId:f.intent.mainId,mainInstallationId:f.execution.acceptedSpec.target.mainInstallationId,bootId:randomUUID()},randomUUID());const chunk={executionId:f.execution.id,attemptId:f.execution.attemptId,sequence:1,stream:'stdout' as const,text:'a',byteSize:1,createdAt:new Date().toISOString()};await f.journal.jobAppendLog(f.intent.operationId,chunk);expect(await f.journal.jobPendingLogs(f.intent.operationId)).toEqual([chunk]);await f.journal.jobAcknowledgeLog(f.intent.operationId,1);expect(await f.journal.jobPendingLogs(f.intent.operationId)).toEqual([]);await expect(f.journal.jobAppendLog(f.intent.operationId,{...chunk,text:'different',byteSize:9})).rejects.toThrow('conflict')})
})
