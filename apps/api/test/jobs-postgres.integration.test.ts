import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { JobService } from '../src/modules/jobs/service.js'
import { JobWorkerService } from '../src/modules/jobs/worker.js'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'
import { buildQueueFixture } from './helpers/buildComputerFixture.js'
import { DomainError } from '../src/modules/errors.js'

/** Real PostgreSQL, authenticated HTTP/MCP, receipts and live revocation. No physical launch claim. */
describe.skipIf(!postgresEnabled)('CI authenticated job persistence and denied MCP parity',()=>{
  let database:Awaited<ReturnType<typeof agent3Database>>,app:ReturnType<typeof buildApp>,address:string
  let access:PostgresAccessService,jobs:JobService,worker:JobWorkerService
  let writer:Awaited<ReturnType<PostgresAccessService['issue']>>,reader:Awaited<ReturnType<PostgresAccessService['issue']>>
  let workspaceId: string
  let queue: Awaited<ReturnType<typeof buildQueueFixture>>
  const clients:Client[]=[]
  beforeAll(async()=>{
    database=await agent3Database()
    access=new PostgresAccessService(database.pool)
    writer=await access.issue({name:'CI writer fixture',audience:'operator',expiresAt:new Date(Date.now()+3600000),grants:[{actions:['job_definitions:read','job_definitions:write','jobs:start','jobs:read','jobs:cancel','job_logs:read','job_artifacts:read','capabilities:read','settings:read','settings:update'],scope:{}}]})
    queue = await buildQueueFixture(database.pool, writer.principal)
    workspaceId = queue.workspaceId
    queue.online()
    jobs = queue.jobs
    const commands = queue.commands
    reader=await access.issue({name:'CI reader fixture',audience:'operator',expiresAt:new Date(Date.now()+3600000),grants:[{actions:['job_definitions:read','jobs:read','job_logs:read','job_artifacts:read','capabilities:read'],scope:{workspaceIds:[workspaceId]}}]})
    worker=new JobWorkerService(database.pool,{require:async()=>{},verifyPublication:async()=>{}})
    app=buildApp({readiness:{database:{ping:async()=>{}},checkpoints:{ping:async()=>{}}},operator:{access,services:{jobs,commands,workflows:new WorkflowManagementService(database.pool,commands)} as unknown as OperatorServices}})
    address=await app.listen({host:'127.0.0.1',port:0})
  },60000)
  afterAll(async()=>{await Promise.allSettled(clients.map(client=>client.close()));await app?.close();await jobs?.closeQueue();await database?.close()})
  const root=()=>`/api/management/workspaces/${workspaceId}/jobs`
  async function connect(token:string) {const client=new Client({name:'ci-tests',version:'1'});clients.push(client);await client.connect(new StreamableHTTPClientTransport(new URL('/mcp',address),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));return client}
  it('persists accepted version after edits/restart, replays one command, conflicts changed payload, and matches MCP readback',async()=>{
    const saved=await app.inject({method:'POST',url:`${root()}/definitions`,headers:{authorization:`Bearer ${writer.token}`},payload:{commandId:randomUUID(),expectedRevision:null,name:'Version one',spec:queue.computers[0]!.candidate.spec}})
    expect(saved.statusCode).toBe(200);const definition=saved.json().definition
    const command={commandId:randomUUID(),definitionId:definition.id,expectedRevision:1}
    const started=await app.inject({method:'POST',url:`${root()}/executions`,headers:{authorization:`Bearer ${writer.token}`},payload:command})
    expect(started.statusCode).toBe(200)
    const admission = started.json().admission
    expect(['pending-admission', 'accepted']).toContain(admission.kind)
    await jobs.wakeQueue()
    const ticketId = admission.kind === 'accepted' ? admission.ticketId : admission.ticket.id
    const ticket = await jobs.getQueueTicket(reader.principal, workspaceId, ticketId)
    const execution = await jobs.getExecution(reader.principal, workspaceId, ticket.executionId)
    const client=await connect(writer.token)
    const replay=await client.callTool({name:'job_start',arguments:{workspaceId,...command}})
    expect(replay.isError).not.toBe(true);expect(replay.structuredContent).toEqual({admission:{kind:'accepted',ticketId,executionId:execution.id}})
    const edited=await app.inject({method:'POST',url:`${root()}/definitions`,headers:{authorization:`Bearer ${writer.token}`},payload:{commandId:randomUUID(),id:definition.id,expectedRevision:1,name:'Version two',spec:{...queue.computers[0]!.candidate.spec,argv:['node','different.mjs']}}})
    expect(edited.statusCode).toBe(200)
    const historic=await client.callTool({name:'job_definition_version_get',arguments:{workspaceId,definitionId:definition.id,versionId:definition.versionId}})
    expect(historic.structuredContent).toEqual({definition})
    const historicHttp=await app.inject({method:'GET',url:`${root()}/definitions/${definition.id}/versions/${definition.versionId}`,headers:{authorization:`Bearer ${reader.token}`}})
    expect(historicHttp.statusCode).toBe(200);expect(historicHttp.json()).toEqual({definition})
    const foreignVersion=await client.callTool({name:'job_definition_version_get',arguments:{workspaceId:'foreign',definitionId:definition.id,versionId:definition.versionId}})
    expect(foreignVersion.isError).toBe(true);expect(JSON.stringify(foreignVersion.content)).toContain('ACCESS_DENIED')
    const conflict=await client.callTool({name:'job_start',arguments:{workspaceId,...command,expectedRevision:2}})
    expect(conflict.isError).toBe(true);expect(JSON.stringify(conflict.content)).toContain('COMMAND_ID_CONFLICT')
    const read=await client.callTool({name:'job_get',arguments:{workspaceId,executionId:execution.id}})
    expect(read.structuredContent).toEqual({execution})
    const fresh=await jobs.repository.execution(database.pool,workspaceId,execution.id)
    expect(fresh.acceptedSpec.definitionRevision).toBe(1);expect(fresh.acceptedSpec.argv).toEqual(queue.computers[0]!.candidate.spec.argv)
    expect(Number((await database.pool.query('select count(*) from job_executions where workspace_id=$1',[workspaceId])).rows[0].count)).toBe(1)
    const fenced={attemptId:execution.attemptId,owner:execution.owner}
    const chunk={executionId:execution.id,attemptId:execution.attemptId,sequence:1,stream:'stdout' as const,text:'🙂',byteSize:4,createdAt:new Date().toISOString()}
    expect(await worker.appendLog(workspaceId,execution.id,fenced,chunk)).toEqual({persistedSequence:1,truncated:false})
    expect(await worker.appendLog(workspaceId,execution.id,fenced,chunk)).toEqual({persistedSequence:1,truncated:false})
    await expect(worker.appendLog(workspaceId,execution.id,fenced,{...chunk,sequence:3})).rejects.toMatchObject({code:'JOB_LOG_GAP'})
    await worker.settleProcess(workspaceId,execution.id,fenced,{process:{phase:'terminal',outcome:'build_failed',exitCode:7,signal:null,processStopped:true},startedAt:new Date().toISOString(),finishedAt:new Date().toISOString()})
    const result=await jobs.getExecution(reader.principal,workspaceId,execution.id)
    expect(result.process.exitCode).toBe(7);expect(result.process.outcome).toBe('build_failed');expect(result.transport).toBe('connected')
    await queue.complete(execution.id)
  })
  it('retains a timed-out source attempt through queued HTTP/MCP retries and resumes only its original identity',async()=>{
    const saved=await app.inject({method:'POST',url:`${root()}/definitions`,headers:{authorization:`Bearer ${writer.token}`},payload:{commandId:randomUUID(),expectedRevision:null,name:'Retained preparation',spec:queue.computers[0]!.candidate.spec}})
    expect(saved.statusCode).toBe(200)
    const command={commandId:randomUUID(),definitionId:saved.json().definition.id,expectedRevision:1}
    const error=new DomainError('SOURCE_REPOSITORY_TIMEOUT','Private source preparation timed out.',503,{retryable:true})
    const originalAccept = queue.accept.getMockImplementation()!
    queue.accept.mockRejectedValue(error)
    const client=await connect(writer.token)
    try {
      const http=await app.inject({method:'POST',url:`${root()}/executions`,headers:{authorization:`Bearer ${writer.token}`},payload:command})
      expect(http.statusCode).toBe(200)
      expect(http.json().admission.kind).toBe('pending-admission')
      await expect(jobs.wakeQueue()).rejects.toMatchObject({code:error.code,details:{retryable:true}})
      const ticketId = http.json().admission.ticket.id
      const retained=(await database.pool.query('select execution_id,attempt_id,operation_id from job_preparations where principal_id=$1 and command_id=$2',[writer.principal.id,command.commandId])).rows
      expect(retained).toHaveLength(1)
      const mcp=await client.callTool({name:'job_start',arguments:{workspaceId,...command}})
      expect(mcp.isError).not.toBe(true)
      expect(mcp.structuredContent?.admission).toMatchObject({kind:'pending-admission',ticket:{id:ticketId,state:'claimed'}})
      await expect(jobs.wakeQueue()).rejects.toMatchObject({code:error.code})
      expect((await database.pool.query('select execution_id,attempt_id,operation_id from job_preparations where principal_id=$1 and command_id=$2',[writer.principal.id,command.commandId])).rows).toEqual(retained)
      expect((await database.pool.query('select id from job_executions where id=$1',[retained[0].execution_id])).rows).toHaveLength(0)
      const calls = queue.accept.mock.calls.length
      const denied=await (await connect(reader.token)).callTool({name:'job_start',arguments:{workspaceId,...command}})
      expect(denied.isError).toBe(true)
      expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
      expect(queue.accept).toHaveBeenCalledTimes(calls)
      queue.accept.mockImplementation(originalAccept)
      await jobs.wakeQueue()
      const resumed=await client.callTool({name:'job_start',arguments:{workspaceId,...command}})
      expect(resumed.isError).not.toBe(true)
      expect(resumed.structuredContent?.admission).toEqual({kind:'accepted',ticketId,executionId:retained[0].execution_id})
      const read=await client.callTool({name:'job_get',arguments:{workspaceId,executionId:retained[0].execution_id}})
      expect(read.isError).not.toBe(true)
      expect(read.structuredContent?.execution).toMatchObject({id:retained[0].execution_id,attemptId:retained[0].attempt_id,operationId:retained[0].operation_id})
      expect((await database.pool.query('select result from management_command_receipts where principal_id=$1 and command_id=$2',[writer.principal.id,command.commandId])).rows).toHaveLength(1)
    } finally {queue.accept.mockImplementation(originalAccept)}
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
