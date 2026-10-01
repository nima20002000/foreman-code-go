import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, stat, readFile, writeFile, symlink, rm, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { jobExecution } from './helpers/jobFixture.js'
import { ReadonlyJobInputDelivery, type JobInputDeliverySource } from '../src/modules/files/jobInputs/delivery.js'
import { makeManifest, manifestBytes, snapshotDigest } from '../src/modules/files/jobInputs/manifest.js'
import { JobBuildInputManifestSchema, JobInputAdmissionSchema } from '@graphql/contracts/job-inputs'
const digest=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex')
const roots:string[]=[]
afterEach(async()=>{for(const root of roots.splice(0)){await chmod(join(root,'project/.graphql-job-inputs'),0o700).catch(()=>{});await rm(root,{recursive:true,force:true})}})
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'job-input-'));roots.push(root);const project=join(root,'project');await mkdir(project)
 const statValue=await stat(project);const fdInfo=await readFile('/proc/self/mountinfo','utf8');const mount=fdInfo.split('\n').filter(line=>{const path=line.split(' ')[4]!;return project===path||project.startsWith(path==='/'?'/':`${path}/`)}).sort((a,b)=>b.split(' ')[4]!.length-a.split(' ')[4]!.length)[0]!.split(' ')[0]!
 const execution=jobExecution();execution.acceptedSpec.target.destination.canonicalProjectRoot=project
 execution.acceptedSpec.target.destination.directoryIdentityHash=digest(Buffer.from(JSON.stringify({device:String(statValue.dev),inode:String(statValue.ino),mountId:mount})))
 const manifest=makeManifest(execution,[]),admission=JobInputAdmissionSchema.parse({version:1,manifest,principalId:'actor',principalGrantsDigest:'1'.repeat(64),issuedAt:'2026-10-01T00:00:00.000Z',transfers:[]})
 let denied=false
 const source:JobInputDeliverySource={admit:async()=>admission,recheck:async()=>{if(denied)throw new Error('revoked')},read:async(_execution,_admission,path,offset,length)=>{const bytes=path==='manifest.json'?manifestBytes(manifest):Buffer.from('null');return bytes.subarray(offset,offset+length)}}
 const verified={privateRepositoryRoot:project,directoryIdentityHash:execution.acceptedSpec.target.destination.directoryIdentityHash,privateGit:true as const,diskQuotaBytes:1024*1024}
 return {root,project,execution,manifest,verified,source,deny:()=>{denied=true},delivery:new ReadonlyJobInputDelivery(source,join(root,'receipts'))}
}
describe('immutable job input copies',()=>{
 it('delivers empty/manual-null supported inputs with a private receipt and required readonly mount',async()=>{
  const f=await fixture(),receipt=await f.delivery.prepare(f.execution,f.verified,new AbortController().signal)
  expect(receipt.files.map(file=>file.relativePath)).toEqual(['manifest.json','workflow-input.json']);expect(receipt.readonlyMountRequired).toBe(true)
  const build=JobBuildInputManifestSchema.parse(JSON.parse(await readFile(join(f.project,'.graphql-job-inputs/manifest.json'),'utf8')))
  expect(build.inputSnapshotDigest).toBe(snapshotDigest(f.execution));expect(JSON.stringify(build)).not.toContain('grant-fixture')
  expect(await f.delivery.prepare(f.execution,f.verified,new AbortController().signal)).toEqual(receipt)
 })
 it('rejects changed retained bytes on original receipt retry',async()=>{const f=await fixture();await f.delivery.prepare(f.execution,f.verified,new AbortController().signal);await chmod(join(f.project,'.graphql-job-inputs/workflow-input.json'),0o600);await writeFile(join(f.project,'.graphql-job-inputs/workflow-input.json'),'evil');await expect(f.delivery.prepare(f.execution,f.verified,new AbortController().signal)).rejects.toThrow('hash differs')})
 it('reauthorizes original copies after revocation',async()=>{const f=await fixture();await f.delivery.prepare(f.execution,f.verified,new AbortController().signal);f.deny();await expect(f.delivery.prepare(f.execution,f.verified,new AbortController().signal)).rejects.toThrow('revoked')})
 it('rejects a source supplied reserved symlink',async()=>{const f=await fixture();await symlink(f.root,join(f.project,'.graphql-job-inputs'));await expect(f.delivery.prepare(f.execution,f.verified,new AbortController().signal)).rejects.toThrow('reserved input directory')})
 it('rejects a symlinked host-private receipt',async()=>{const f=await fixture();await mkdir(join(f.root,'receipts'),{mode:0o700});const destination=join(f.root,'external');await writeFile(destination,'{}');await symlink(destination,join(f.root,'receipts',`${f.manifest.bindingId}.json`));await expect(f.delivery.prepare(f.execution,f.verified,new AbortController().signal)).rejects.toThrow()})
 it('rejects accepted directory identity changes',async()=>{const f=await fixture();f.verified.directoryIdentityHash='0'.repeat(64);await expect(f.delivery.prepare(f.execution,f.verified,new AbortController().signal)).rejects.toThrow('previously verified')})
})
