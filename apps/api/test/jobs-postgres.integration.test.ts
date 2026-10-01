import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { jobsMigration } from '../src/infrastructure/jobsMigration.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { JobService } from '../src/modules/jobs/service.js'
import { JobWorkerService } from '../src/modules/jobs/worker.js'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'
import { jobSpec } from './helpers/jobFixture.js'

/** Real PostgreSQL, authenticated HTTP/MCP, receipts and live revocation. No physical launch claim. */
describe.skipIf(!postgresEnabled)('CI authenticated job persistence and denied MCP parity',()=>{
  let database:Awaited<ReturnType<typeof agent3Database>>,app:ReturnType<typeof buildApp>,address:string
  let access:PostgresAccessService,jobs:JobService,worker:JobWorkerService
  let writer:Awaited<ReturnType<PostgresAccessService['issue']>>,reader:Awaited<ReturnType<PostgresAccessService['issue']>>
  const workspaceId=`ci-integration-${randomUUID()}`,clients:Client[]=[]
  beforeAll(async()=>{
    database=await agent3Database()
    const migration=(await database.pool.query('select 1 from application_migrations where version=$1',[jobsMigration.version])).rows.length
    if(!migration) {
      const sql=await database.pool.connect()
      try {await sql.query('begin');await sql.query(jobsMigration.sql);await sql.query('insert into application_migrations(version) values($1)',[jobsMigration.version]);await sql.query('commit')} finally {sql.release()}
    }
    access=new PostgresAccessService(database.pool)
    const commands=new PostgresCommandCoordinator(database.pool)
    await database.pool.query('insert into workspaces(id,record) values($1,$2::jsonb)',[workspaceId,JSON.stringify({id:workspaceId,name:'Synthetic CI scope'})])
    writer=await access.issue({name:'CI writer fixture',audience:'operator',expiresAt:new Date(Date.now()+3600000),grants:[{actions:['job_definitions:read','job_definitions:write','jobs:start','jobs:read','jobs:cancel','job_logs:read','job_artifacts:read','capabilities:read'],scope:{workspaceIds:[workspaceId]}}]})
    reader=await access.issue({name:'CI reader fixture',audience:'operator',expiresAt:new Date(Date.now()+3600000),grants:[{actions:['job_definitions:read','jobs:read','job_logs:read','job_artifacts:read','capabilities:read'],scope:{workspaceIds:[workspaceId]}}]})
    jobs=new JobService(database.pool,commands,{
      preparation:{choices:async()=>({targets:[],sources:[],policies:[]}),validate:async()=>({valid:true,reasons:[],sideEffects:false}),accept:async(_sql,_principal,_workspace,spec)=>spec},
      dispatch:{accept:async()=>({operationId:randomUUID(),attemptId:randomUUID(),owner:{grantId:randomUUID(),epoch:'1'}}),cancel:async()=>{},wake:async()=>{}},
      artifacts:{list:async()=>[],read:async()=>{throw new Error('No physical artifact fixture')}},
    })
    worker=new JobWorkerService(database.pool,{require:async()=>{},verifyPublication:async()=>{}})
    app=buildApp({readiness:{database:{ping:async()=>{}},checkpoints:{ping:async()=>{}}},operator:{access,services:{jobs,commands,workflows:new WorkflowManagementService(database.pool,commands)} as unknown as OperatorServices}})
    address=await app.listen({host:'127.0.0.1',port:0})
  },60000)
  afterAll(async()=>{await Promise.allSettled(clients.map(client=>client.close()));await app?.close();await database?.close()})
  const root=()=>`/api/management/workspaces/${workspaceId}/jobs`
  async function connect(token:string) {const client=new Client({name:'ci-tests',version:'1'});clients.push(client);await client.connect(new StreamableHTTPClientTransport(new URL('/mcp',address),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));return client}
  it('persists accepted version after edits/restart, replays one command, conflicts changed payload, and matches MCP readback',async()=>{
    const saved=await app.inject({method:'POST',url:`${root()}/definitions`,headers:{authorization:`Bearer ${writer.token}`},payload:{commandId:randomUUID(),expectedRevision:null,name:'Version one',spec:jobSpec()}})
    expect(saved.statusCode).toBe(200);const definition=saved.json().definition
    const command={commandId:randomUUID(),definitionId:definition.id,expectedRevision:1}
    const started=await app.inject({method:'POST',url:`${root()}/executions`,headers:{authorization:`Bearer ${writer.token}`},payload:command})
    expect(started.statusCode).toBe(200);const execution=started.json().execution
    const client=await connect(writer.token)
    const replay=await client.callTool({name:'job_start',arguments:{workspaceId,...command}})
    expect(replay.isError).not.toBe(true);expect(replay.structuredContent).toEqual({execution})
    const edited=await app.inject({method:'POST',url:`${root()}/definitions`,headers:{authorization:`Bearer ${writer.token}`},payload:{commandId:randomUUID(),id:definition.id,expectedRevision:1,name:'Version two',spec:{...jobSpec(),argv:['node','different.mjs']}}})
    expect(edited.statusCode).toBe(200)
    const conflict=await client.callTool({name:'job_start',arguments:{workspaceId,...command,expectedRevision:2}})
    expect(conflict.isError).toBe(true);expect(JSON.stringify(conflict.content)).toContain('COMMAND_ID_CONFLICT')
    const read=await client.callTool({name:'job_get',arguments:{workspaceId,executionId:execution.id}})
    expect(read.structuredContent).toEqual({execution})
    const fresh=await jobs.repository.execution(database.pool,workspaceId,execution.id)
    expect(fresh.acceptedSpec.definitionRevision).toBe(1);expect(fresh.acceptedSpec.argv).toEqual(jobSpec().argv)
    expect(Number((await database.pool.query('select count(*) from job_executions where workspace_id=$1',[workspaceId])).rows[0].count)).toBe(1)
    const fenced={attemptId:execution.attemptId,owner:execution.owner}
    const chunk={executionId:execution.id,attemptId:execution.attemptId,sequence:1,stream:'stdout' as const,text:'🙂',byteSize:4,createdAt:new Date().toISOString()}
    expect(await worker.appendLog(workspaceId,execution.id,fenced,chunk)).toEqual({persistedSequence:1,truncated:false})
    expect(await worker.appendLog(workspaceId,execution.id,fenced,chunk)).toEqual({persistedSequence:1,truncated:false})
    await expect(worker.appendLog(workspaceId,execution.id,fenced,{...chunk,sequence:3})).rejects.toMatchObject({code:'JOB_LOG_GAP'})
    await worker.settleProcess(workspaceId,execution.id,fenced,{process:{phase:'terminal',outcome:'build_failed',exitCode:7,signal:null,processStopped:true},startedAt:new Date().toISOString(),finishedAt:new Date().toISOString()})
    const result=await jobs.getExecution(reader.principal,workspaceId,execution.id)
    expect(result.process.exitCode).toBe(7);expect(result.process.outcome).toBe('build_failed');expect(result.transport).toBe('connected')
  })
  it('denies read-only MCP writes, wrong workspace and revoked live authority without probing source',async()=>{
    const client=await connect(reader.token)
    const denied=await client.callTool({name:'job_start',arguments:{workspaceId,commandId:randomUUID(),definitionId:'unprobed',expectedRevision:1}})
    expect(denied.isError).toBe(true);expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
    const foreign=await app.inject({method:'GET',url:'/api/management/workspaces/foreign/jobs/definitions',headers:{authorization:`Bearer ${writer.token}`}})
    expect(foreign.statusCode).toBe(403)
    await database.pool.query('update management_principals set revoked_at=clock_timestamp() where id=$1',[reader.principal.id])
    await expect(jobs.listDefinitions(reader.principal,workspaceId)).rejects.toMatchObject({code:'AUTH_REVOKED'})
  })
})
