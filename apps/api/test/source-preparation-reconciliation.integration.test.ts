import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { DeviceSessionBinding } from '@graphql/contracts/device-connection'
import { DeviceConnectionIdentitySchema } from '@graphql/contracts/device-identity'
import { SourceRootRecordSchema } from '@graphql/contracts/source-admission'
import { SourceFilesystemOperationSchema } from '@graphql/contracts/source-operations'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { JobService } from '../src/modules/jobs/service.js'
import { WorkerExecutionPolicy } from '../src/modules/settings/workerExecution.js'
import { PostgresSourceService } from '../src/modules/sources/service.js'
import { PostgresSourceReservations } from '../src/modules/sources/reservations.js'
import { PrivateSourceSnapshotStore } from '../src/modules/sources/store.js'
import { PrivateSourceMaterializer } from '../src/modules/sources/materialization.js'
import { sourceBindingHash } from '../src/modules/sources/bindingHash.js'
import { createSourceManifest, sourceSha256 } from '../src/modules/sources/manifest.js'
import { openPrivateRoot, identity } from '../src/modules/sources/privateFilesystem.js'
import { qualifyApprovedRootAllowlist } from '../src/modules/sources/rootAttestation.js'
import { PostgresSourceOperationAuthority } from '../src/modules/sources/operationAuthority.js'
import { SourceOperationWorkerService } from '../src/modules/sources/operationWorker.js'
import { CarrierRemoteSourceMaterializationHost } from '../src/modules/sources/operationCarrier.js'
import { RemoteOperationJournal } from '../src/modules/runs/remote/operationJournal.js'
import { DomainError } from '../src/modules/errors.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'
import { jobSpec } from './helpers/jobFixture.js'

/** Actual SQL/HTTP/MCP, protected local filesystem and worker source service.
 * The paired W07 carrier is an in-memory boundary; no laptop/container proof. */
describe.skipIf(!postgresEnabled)('failed Job source preparation reconciliation', () => {
  let database: Awaited<ReturnType<typeof agent3Database>>, app: ReturnType<typeof buildApp>, address: string, directory: string
  let access: PostgresAccessService, sources: PostgresSourceService, journal: RemoteOperationJournal
  let writer: Awaited<ReturnType<PostgresAccessService['issue']>>, reader: Awaited<ReturnType<PostgresAccessService['issue']>>
  const workspaceId = `source-reconcile-${randomUUID()}`, clients: Client[] = [], commandsToReconcile: string[] = []
  let root: ReturnType<typeof SourceRootRecordSchema.parse>, definitionId: string, worker: SourceOperationWorkerService, binding: DeviceSessionBinding
  let pause: { entered(): void; released: Promise<void> } | null = null
  beforeAll(async () => {
    database = await agent3Database(); directory = await mkdtemp('/tmp/jobprep-reconcile-sql-')
    const runtime = join(directory, 'runtime'), project = join(directory, 'project'), policyId = randomUUID()
    await mkdir(runtime, { mode: 0o700 }); await mkdir(project, { mode: 0o700 }); await mkdir(join(runtime, 'source-materializations'), { mode: 0o700 })
    const namespace = join(runtime, 'source-materializations', policyId); await mkdir(namespace, { mode: 0o700 })
    const mainId = (await database.pool.query<{id: string}>('select id from application_installation where singleton=true')).rows[0]!.id
    binding = { mainId, deviceId: randomUUID(), workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1,
      bootId: randomUUID(), connectionEpoch: randomUUID(), connectionGeneration: 1 }
    await database.pool.query('insert into device_registrations(id,main_id,worker_installation_id,public_key,record) values($1,$2,$3,$4,$5::jsonb)',
      [binding.deviceId,mainId,binding.workerInstallationId,'synthetic-pairing-fixture',JSON.stringify({ mainId,deviceId:binding.deviceId,workerInstallationId:binding.workerInstallationId,
        keyRevision:1,authorizationRevision:1,publicKeyFingerprint:'f'.repeat(64),status:'paired',scopes:['connect','heartbeat'] })])
    await database.pool.query('insert into workspaces(id,record) values($1,$2::jsonb)', [workspaceId,JSON.stringify({id:workspaceId,name:'Failed source preparation fixture'})])
    access = new PostgresAccessService(database.pool)
    writer = await access.issue({ name: 'Scoped cleanup writer', audience: 'operator', expiresAt: new Date(Date.now() + 600000),
      grants: [{ actions: ['sources:read','sources:reconcile','source_roots:read','job_definitions:read','job_definitions:write','jobs:start','jobs:read','capabilities:read'], scope: {workspaceIds:[workspaceId]} }] })
    reader = await access.issue({ name: 'Scoped source reader', audience: 'operator', expiresAt: new Date(Date.now() + 600000),
      grants: [{ actions: ['sources:read','source_roots:read','capabilities:read'], scope: {workspaceIds:[workspaceId]} }] })
    const bytes = Buffer.from('original immutable source'), manifest = createSourceManifest({ version:1,snapshotId:randomUUID(),approvedSourceId:randomUUID(),
      capturePolicy:'git-tree-v1',git:{commit:'2'.repeat(40),tree:'3'.repeat(40),objectFormat:'sha1'},executablePolicy:'strip',deletions:[],
      entries:[{path:'source.txt',kind:'file',byteSize:bytes.length,sha256:sourceSha256(bytes),executable:false}] })
    const handle = await openPrivateRoot(namespace), filesystem = await identity(handle); await handle.close()
    root = SourceRootRecordSchema.parse({version:1,source:{approvedSourceId:manifest.approvedSourceId,snapshotId:manifest.snapshotId,manifestDigest:manifest.manifestDigest},
      selection:{hostRef:{kind:'device',mainId,deviceId:binding.deviceId},rootPolicyId:policyId,rootPolicyRevision:'1',locationRevision:'1'},
      binding:{version:1,mainId,deviceId:binding.deviceId,workerInstallationId:binding.workerInstallationId,workspaceId,rootId:randomUUID(),bindingRevision:1,locationRevision:1,
        canonicalPath:namespace,filesystem,accessMode:'exclusive-write',snapshotId:manifest.snapshotId,manifestDigest:manifest.manifestDigest},
      registration:{workerInstallationId:binding.workerInstallationId,keyRevision:1,authorizationRevision:1},ownerPrincipalId:writer.principal.id,authorizedByPrincipalId:writer.principal.id,
      attestationId:randomUUID(),attestationDigest:'a'.repeat(64),boundAt:new Date().toISOString()})
    await database.pool.query("insert into source_approvals(approved_source_id,snapshot_id,workspace_id,owner_principal_id,requested_by,command_id,input_hash,state,origin,request) values($1,$2,$3,$4,$4,$5,$6,'approved','{}','{}')",
      [manifest.approvedSourceId,manifest.snapshotId,workspaceId,writer.principal.id,randomUUID(),'f'.repeat(64)])
    await database.pool.query('insert into source_snapshots(snapshot_id,approved_source_id,workspace_id,manifest_digest,record) values($1,$2,$3,$4,$5::jsonb)',
      [manifest.snapshotId,manifest.approvedSourceId,workspaceId,manifest.manifestDigest,JSON.stringify({version:1,workspaceId,ownerPrincipalId:writer.principal.id,approvedByPrincipalId:writer.principal.id,
        locationRevision:1,mainId,originIdentityHash:`sha256:${'f'.repeat(64)}`,manifest,approvedAt:new Date().toISOString(),availability:'retained'})])
    await database.pool.query('insert into source_root_catalog(root_id,workspace_id,scope_hash,current_binding_revision) values($1,$2,$3,1)',[root.binding.rootId,workspaceId,randomUUID()])
    await database.pool.query('insert into source_root_bindings(root_id,binding_revision,workspace_id,snapshot_id,record) values($1,1,$2,$3,$4::jsonb)',[root.binding.rootId,workspaceId,manifest.snapshotId,JSON.stringify(root)])
    await database.pool.query("insert into workspace_root_policies(root_policy_id,root_policy_revision,workspace_id,host_scope,location_revision,record) values($1,1,$2,$3,1,'{}')",[policyId,workspaceId,randomUUID()])
    const approved = await qualifyApprovedRootAllowlist({schemaVersion:1,hostRef:root.selection.hostRef,applicationInstallationId:binding.workerInstallationId,
      configurationRevision:'1',bases:[{baseId:randomUUID(),canonicalPath:project,accessModes:['read-only','read-write']}],managedRuntimeRoot:runtime})
    journal = await RemoteOperationJournal.open(join(directory, 'job-journal.json'), { initializeNewInstallation: true })
    const unused = async (): Promise<never> => { throw new Error('No native execution or transfer in this fixture') }
    const attempts = { authorize: async () => {}, authorizeFinal: async () => {}, revalidate: async () => {}, revalidateMaterialization: async () => {} }
    const owners = new PostgresSourceOperationAuthority(database.pool, attempts, async () => false)
    worker = new SourceOperationWorkerService({authenticate:async context=>{expect(context.binding).toEqual(binding)},approvedRoots:async()=>approved,
      currentOwner:(operation,context)=>owners.resolve(operation,DeviceConnectionIdentitySchema.parse({mainId:context.binding.mainId,deviceId:context.binding.deviceId,
        workerInstallationId:context.binding.workerInstallationId,keyRevision:1,authorizationRevision:1,bootId:context.binding.bootId,connectionGeneration:1})),
      transfers:{resolveVerifiedReceipt:unused,openVerified:unused},transferContext:async()=>binding,
      preparationNativeClosed:async operationId=>(await journal.jobNativeOwner(operationId))===null})
    const remote = new CarrierRemoteSourceMaterializationHost({capture:()=>({identity:DeviceConnectionIdentitySchema.parse({mainId,deviceId:binding.deviceId,
      workerInstallationId:binding.workerInstallationId,keyRevision:1,authorizationRevision:1,bootId:binding.bootId,connectionGeneration:1}),
      request:async(_namespace,request)=>({payload:await worker.handle(SourceFilesystemOperationSchema.parse(request),{binding,signal:new AbortController().signal})})})},owners,{send:unused})
    const commands = new PostgresCommandCoordinator(database.pool)
    const materializer = new PrivateSourceMaterializer({read:async()=>bytes},async()=>{})
    sources = new PostgresSourceService(database.pool,commands,{} as never,new PrivateSourceSnapshotStore(join(directory,'snapshots')),mainId,{} as never,
      {authorize:async()=>{},authorizeFinal:async()=>{},prepare:(manifest,root,attempt)=>materializer.prepare({manifest,binding:root.binding,attempt}),verify:unused,verifyWorkingDirectory:unused,releaseClaim:unused,
        reconcilePreparation:(id,owner)=>remote.reconcilePreparation(id,owner)}, {confirmedClosed:async()=>false})
    const spec = jobSpec(); spec.source={...root.source,commit:manifest.git!.commit}
    spec.target={...spec.target,mainId,mainInstallationId:mainId,hostRef:root.selection.hostRef,registration:root.registration,
      destination:{...spec.target.destination,canonicalProjectRoot:namespace,canonicalCwd:namespace,managedRuntimeRoot:runtime,rootPolicyId:policyId,attestationId:root.attestationId,attestationHash:root.attestationDigest}}
    spec.policy.preparationTimeoutMs=600000
    const jobs = new JobService(database.pool,commands,{
      workerExecution: new WorkerExecutionPolicy({ enabled: true, managedBy: 'startup' }),
      preparation:{choices:async()=>({targets:[],sources:[],policies:[]}),validate:async()=>({valid:true,reasons:[],sideEffects:false}),
      revalidateAccepted:async()=>{},adoptFinalBinding:async()=>{},accept:async(_sql,principal,_workspace,_spec,identity)=>{
        const attempt={executionId:identity.executionId,attemptId:identity.attemptId,placementHash:'',keyRevision:1,authorizationRevision:1};attempt.placementHash=sourceBindingHash(root,attempt,identity.operationId)
        await sources.prepareExecution({principal,workspaceId,rootId:root.binding.rootId,bindingRevision:1,source:root.source,attempt,operationId:identity.operationId})
        if(pause) {pause.entered();await pause.released}
        throw new DomainError('SOURCE_REPOSITORY_TIMEOUT','Private repository fixture failure',503)
      }},dispatch:{accept:unused,cancelForRunCleanup:unused,cancel:unused,wake:unused},artifacts:{list:async()=>[],read:unused}})
    app = buildApp({logger:pino({level:'error'}),readiness:{database:{ping:async()=>{}},checkpoints:{ping:async()=>{}}},operator:{access,services:{sources,jobs,commands} as unknown as OperatorServices}})
    address = await app.listen({host:'127.0.0.1',port:0})
    const save = await app.inject({method:'POST',url:`/api/management/workspaces/${workspaceId}/jobs/definitions`,headers:{authorization:`Bearer ${writer.token}`},
      payload:{commandId:randomUUID(),expectedRevision:null,name:'Failure before native admission',spec}})
    expect(save.statusCode).toBe(200);definitionId=save.json().definition.id
    for(let i=0;i<2;i++) {
      const commandId=randomUUID();commandsToReconcile.push(commandId)
      const result=await start(commandId);expect(result.statusCode).toBeGreaterThanOrEqual(400)
    }
  },60000)
  afterAll(async()=>{await Promise.allSettled(clients.map(client=>client.close()));await app?.close();await journal?.close();await database?.close();if(directory)await rm(directory,{recursive:true,force:true})})
  const sourceUrl=()=>`/api/management/workspaces/${workspaceId}/source-preparations`
  const start=(commandId:string)=>app.inject({method:'POST',url:`/api/management/workspaces/${workspaceId}/jobs/executions`,headers:{authorization:`Bearer ${writer.token}`},payload:{commandId,definitionId,expectedRevision:1}})
  async function client(token:string) {const value=new Client({name:'source-reconciliation-fixture',version:'1'});clients.push(value);await value.connect(new StreamableHTTPClientTransport(new URL('/mcp',address),{requestInit:{headers:{authorization:`Bearer ${token}`}}}));return value}
  it('reproduces capacity exhaustion, preserves failed evidence, audits HTTP/MCP cleanup and frees active slots',async()=>{
    const exhausted=await start(randomUUID());expect(exhausted.statusCode,JSON.stringify(exhausted.json())).toBe(409);expect(exhausted.json().error.code).toBe('SOURCE_CAPACITY')
    const rows=(await database.pool.query<{operation_id:string}>('select operation_id from job_preparations where workspace_id=$1 and command_id=any($2) order by created_at',[workspaceId,commandsToReconcile])).rows
    expect(rows).toHaveLength(2)
    const operator=await client(writer.token)
    expect((await operator.listTools()).tools.map(tool=>tool.name)).toContain('source_preparation_reconcile')
    for(const [i,row] of rows.entries()) {
      const before=await app.inject({method:'POST',url:sourceUrl()+'/get',headers:{authorization:`Bearer ${reader.token}`},payload:{operationId:row.operation_id}})
      expect(before.statusCode).toBe(200);expect(before.json().reservationState).toBe(i===0?'owned':'preparing')
      expect((await operator.callTool({name:'source_preparation_get',arguments:{workspaceId,startCommandId:commandsToReconcile[i]!}})).structuredContent).toEqual(before.json())
      const command={operationId:row.operation_id,commandId:randomUUID()}
      const denied=await app.inject({method:'POST',url:sourceUrl()+'/reconcile',headers:{authorization:`Bearer ${reader.token}`},payload:command})
      expect(denied.statusCode).toBe(403)
      const result=await operator.callTool({name:'source_preparation_reconcile',arguments:{workspaceId,...command}})
      expect(result.isError).not.toBe(true)
      const value=(result.structuredContent as {value:{reservationState:string;reservedBytes:number;closure:{materializationId:string|null}}}).value
      expect(value.reservationState).toBe('retained')
      expect(value.reservedBytes).toBe(value.closure.materializationId === null
        ? Math.min(before.json().reservedBytes, 16 * 1024) : before.json().reservedBytes)
      const stored = (await database.pool.query<{ reserved_bytes: string }>(
        'select reserved_bytes from source_storage_reservations where owner_id=$1', [row.operation_id])).rows[0]!
      expect(Number(stored.reserved_bytes)).toBe(value.reservedBytes)
      expect((await operator.callTool({name:'source_preparation_get',arguments:{workspaceId,operationId:row.operation_id}})).structuredContent).toEqual(value)
      const replay=await app.inject({method:'POST',url:sourceUrl()+'/reconcile',headers:{authorization:`Bearer ${writer.token}`},payload:command})
      expect(replay.statusCode).toBe(200);expect(replay.json()).toEqual({value,replayed:true})
      if(value.closure.materializationId) expect(await readFile(join(root.binding.canonicalPath,value.closure.materializationId,'tree/source.txt'),'utf8')).toBe('original immutable source')
      expect(Number((await database.pool.query("select count(*) from management_audit where action='source.preparation.reconcile' and outcome='succeeded' and details->>'commandId'=$1",[command.commandId])).rows[0].count)).toBe(1)
    }
    const sql=await database.pool.connect()
    try {await sql.query('begin');const original=(await sql.query<{record:{scopeId:string}}>('select record from source_storage_reservations where owner_id=$1',[rows[0]!.operation_id])).rows[0]!.record
      await expect(new PostgresSourceReservations().reserve(sql,{scopeId:original.scopeId,ownerKind:'materialization',ownerId:randomUUID(),reservedBytes:1000})).resolves.toHaveProperty('reservationId');await sql.query('rollback')
    } finally {sql.release()}
    expect(Number((await database.pool.query('select count(*) from job_executions where workspace_id=$1',[workspaceId])).rows[0].count)).toBe(0)
    const old=await start(commandsToReconcile[0]!);expect(old.statusCode).toBe(409);expect(old.json().error.code).toBe('SOURCE_PREPARATION_RECONCILED')
    const revoked=await access.issue({name:'Later revoked reader',audience:'operator',expiresAt:new Date(Date.now()+60000),grants:[{actions:['sources:read','source_roots:read'],scope:{workspaceIds:[workspaceId]}}]})
    const deniedClient=await client(reader.token)
    expect((await deniedClient.listTools()).tools.some(tool=>tool.name==='source_preparation_reconcile')).toBe(false)
    await expect(deniedClient.callTool({name:'source_preparation_reconcile',arguments:{workspaceId,operationId:rows[0]!.operation_id,commandId:randomUUID()}})).rejects.toThrow('not found')
    const foreign=await operator.callTool({name:'source_preparation_get',arguments:{workspaceId:'foreign',operationId:rows[0]!.operation_id}});expect(foreign.isError).toBe(true)
    await database.pool.query('update management_principals set revoked_at=now() where id=$1',[revoked.principal.id])
    await expect(sources.preparationGet(revoked.principal,'mcp',{workspaceId,operationId:rows[0]!.operation_id})).rejects.toMatchObject({code:'AUTH_REVOKED'})
  },60000)
  it('keeps capacity and evidence while the original Start command is live, then reconciles its recorded failure',async()=>{
    let entered!:()=>void,release!:()=>void
    const started=new Promise<void>(resolve=>{entered=resolve}),released=new Promise<void>(resolve=>{release=resolve})
    pause={entered,released};const startCommand=randomUUID(),pending=start(startCommand)
    try {
      await started
      const row=(await database.pool.query<{operation_id:string}>('select operation_id from job_preparations where principal_id=$1 and command_id=$2',[writer.principal.id,startCommand])).rows[0]!
      const command={operationId:row.operation_id,commandId:randomUUID()}
      const result=await app.inject({method:'POST',url:sourceUrl()+'/reconcile',headers:{authorization:`Bearer ${writer.token}`},payload:command})
      expect(result.statusCode).toBe(409);expect(result.json().error.code).toBe('SOURCE_PREPARATION_ACTIVE')
      expect((await sources.preparationGet(reader.principal,'http',{workspaceId,operationId:row.operation_id})).reservationState).toBe('owned')
      release();pause=null;expect((await pending).statusCode).toBe(503)
      const closed=await app.inject({method:'POST',url:sourceUrl()+'/reconcile',headers:{authorization:`Bearer ${writer.token}`},payload:command})
      expect(closed.statusCode,JSON.stringify(closed.json())).toBe(200);expect(closed.json().value.reservationState).toBe('retained')
    } finally {release();pause=null;await pending}
  },60000)
})
