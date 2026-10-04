import { AutoJobDefinitionSpecSchema, jobPolicyRequirements } from '@graphql/contracts/jobs'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import pg from 'pg'
import Fastify, { type FastifyInstance } from 'fastify'
import { McpServer } from '@modelcontextprotocol/server'
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { JobExecutionSchema } from '@graphql/contracts/jobs'
import { fileStorageMigration } from '../src/infrastructure/fileStorageMigration.js'
import { fileToolsMigration } from '../src/modules/files/tools/migration.js'
import { jobArtifactStorageMigration } from '../src/infrastructure/jobArtifactStorageMigration.js'
import { JobPublicationAuthority } from '../src/modules/jobs/authority.js'
import { JobService } from '../src/modules/jobs/service.js'
import { createCanonicalJobArtifactPort } from '../src/modules/files/jobs/factory.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { registerJobRoutes } from '../src/routes/jobs.js'
import { registerJobTools, unavailableJobToolCall } from '../src/mcp/operator/tools/jobs.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { DomainError } from '../src/modules/errors.js'
import { jobExecution, jobSpec } from './helpers/jobFixture.js'
const databaseUrl=process.env.TEST_DATABASE_URL
const digest=(v:Uint8Array|string)=>createHash('sha256').update(v).digest('hex')
/** Root-only fixture: real canonical storage/ledger, live grants, actual CI HTTP and SDK MCP tools.
 * Qualified W07/container launch remains a separate real-device acceptance gate. */
describe.skipIf(!databaseUrl).each(['fixed', 'auto'] as const)('CI canonical artifact authenticated persistence (%s)', placementMode=>{
  const schema=`ci_artifacts_${randomUUID().replaceAll('-','')}`
  let admin:pg.Pool,pool:pg.Pool,root:string,app:FastifyInstance
  let address: string
  const clients: Client[] = []
  let artifacts:ReturnType<typeof createCanonicalJobArtifactPort>
  const execution=jobExecution(),ownerToken=`fixture-owner-${randomUUID()}`,deniedToken=`fixture-denied-${randomUUID()}`
  const data=Buffer.from('{"build":"passed"}'),outputPath='dist/report.json'
  beforeAll(async()=>{
    const url=new URL(databaseUrl!)
    if(!['postgres:','postgresql:'].includes(url.protocol)||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||!/test/i.test(url.pathname))throw new Error('Explicit owned loopback TEST_DATABASE_URL required.')
    admin=new pg.Pool({connectionString:databaseUrl});await admin.query(`create schema ${schema}`)
    pool=new pg.Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`})
    await pool.query(`create table operator_conversations(id text primary key);
      create table management_principals(id text primary key,name text,audience text,agent_id text,token_hash text,grants jsonb,expires_at timestamptz,revoked_at timestamptz,delegated_from text);
      create table management_audit(principal_id text,source text,action text,target_key text,outcome text,details jsonb);
      create table job_executions(id text primary key,workspace_id text,record jsonb,accepted_spec jsonb,accepted_by text);
      create table job_definition_versions(id text primary key,workspace_id text,definition_id text,record jsonb);
      create table job_fixture_owner(grant_id text primary key,epoch text,revoked boolean,root_valid boolean);
      insert into job_fixture_owner values('grant-fixture','1',false,true);`)
    await pool.query(fileStorageMigration.sql);await pool.query(fileToolsMigration.sql);await pool.query(jobArtifactStorageMigration.sql)
    for(const [id,token,actions] of [['owner',ownerToken,['jobs:start','job_artifacts:read']],['denied',deniedToken,['jobs:read']]] as const){
      await pool.query("insert into management_principals values($1,$1,'operator',null,$2,$3::jsonb,'2099-01-01',null,null)",[id,digest(token),JSON.stringify([{actions,scope:{workspaceIds:[execution.workspaceId]}}])])
    }
    execution.process={phase:'terminal',outcome:'succeeded',exitCode:0,signal:null,processStopped:true};execution.finishedAt=execution.createdAt
    execution.acceptedSpec.outputs=[{path:outputPath,required:true,mediaType:'application/json'}]
    if (placementMode === 'auto') execution.acceptedSpec.computerSelection = { mode: 'auto', buildPriority: 100, settingsRevision: 1 }
    await pool.query('insert into job_executions values($1,$2,$3::jsonb,$4::jsonb,$5)',[execution.id,execution.workspaceId,JSON.stringify(execution),JSON.stringify(execution.acceptedSpec),'owner'])
    const definition={schemaVersion:1,id:execution.acceptedSpec.definitionId,workspaceId:execution.workspaceId,name:'Original',revision:execution.acceptedSpec.definitionRevision,versionId:execution.acceptedSpec.definitionVersionId,spec:placementMode === 'auto' ? AutoJobDefinitionSpecSchema.parse({ ...jobSpec(),
      outputs: execution.acceptedSpec.outputs, target: { kind: 'auto' }, policy: jobPolicyRequirements(jobSpec().policy),
      limits: { cpuLimit: 1, memoryBytes: 67108864, diskBytes: 8388608, pidsLimit: 32 } })
      : {...jobSpec(),outputs:execution.acceptedSpec.outputs},createdAt:execution.createdAt,updatedAt:execution.createdAt}
    await pool.query('insert into job_definition_versions values($1,$2,$3,$4::jsonb)',[definition.versionId,definition.workspaceId,definition.id,JSON.stringify(definition)])
    root=await mkdtemp(join(process.cwd(),'.ci-artifact-db-'))
    const authority=new JobPublicationAuthority({require:async(sql,job,fence)=>{
      const r=(await sql.query<{epoch:string;revoked:boolean}>('select epoch,revoked from job_fixture_owner where grant_id=$1 for share',[fence.owner.grantId])).rows[0]
      if(!r||r.revoked||r.epoch!==fence.owner.epoch||job.attemptId!==fence.attemptId)throw new DomainError('JOB_OWNER_REVOKED','Owner denied.',403)
    }},{revalidateAccepted:async sql=>{const r=(await sql.query<{root_valid:boolean}>('select root_valid from job_fixture_owner for share')).rows[0];if(r?.root_valid!==true)throw new DomainError('JOB_AUTHORITY_CHANGED','Accepted fixture root is unavailable.',409)}})
    artifacts=createCanonicalJobArtifactPort({pool,storageRoot:root,authority,reader:{open:async()=>Readable.from([data])}})
    const commands=new PostgresCommandCoordinator(pool)
    const jobs=new JobService(pool,commands,{preparation:{} as never,dispatch:{} as never,artifacts})
    app=Fastify();app.decorateRequest('operatorPrincipal',undefined)
    app.addHook('onRequest',async request=>{const token=/^Bearer (.+)$/.exec(request.headers.authorization??'')?.[1];request.operatorPrincipal=await new PostgresAccessService(pool).authenticate(token)})
    app.setErrorHandler((error,_request,reply)=>{void reply.code(error instanceof DomainError?error.status:500).send({error:error instanceof DomainError?error.code:'ERROR'})})
    registerJobRoutes(app,jobs)
    app.post('/mcp',async(request,reply)=>{
      const server=new McpServer({name:'ci-artifact-fixture',version:'1'})
      const context={principal:request.operatorPrincipal!,services:{jobs,commands}}
      const unavailable=await unavailableJobToolCall(context,request.body)
      if(unavailable)return reply.send(unavailable)
      registerJobTools(server,context)
      const transport=new NodeStreamableHTTPServerTransport({sessionIdGenerator:undefined})
      reply.raw.once('close',()=>{void Promise.allSettled([transport.close(),server.close()])})
      await server.connect(transport);reply.hijack();await transport.handleRequest(request.raw,reply.raw,request.body)
    })
    address = await app.listen({ host: '127.0.0.1', port: 0 })
  })
  afterAll(async()=>{await Promise.allSettled(clients.map(client=>client.close()));await app?.close();await pool?.end();if(root)await rm(root,{recursive:true,force:true});if(admin){try{await admin.query(`drop schema ${schema} cascade`)}finally{await admin.end()}}})
  it('finalizes and adopts one exact standalone artifact, then authenticates HTTP/MCP readback and denial',async()=>{
    const input={workspaceId:execution.workspaceId,executionId:execution.id,attemptId:execution.attemptId,owner:execution.owner,
      commandId:'ci-output-command',path:outputPath,mediaType:'application/json' as const,sha256:digest(data),byteSize:data.length}
    const publication=await artifacts.publishAccepted(input),replay=await artifacts.publishAccepted(input,'mcp')
    expect(replay.artifact).toEqual(publication.artifact);expect(replay.replayed).toBe(true)
    await artifacts.verifyRequiredOutputs(pool,execution)
    const p=publication.artifact,base=`/api/management/workspaces/${execution.workspaceId}/jobs/executions/${execution.id}/artifacts`
    const listed=await app.inject({method:'GET',url:base,headers:{authorization:`Bearer ${ownerToken}`}})
    expect(listed.json().artifacts).toEqual([p])
    const read=await app.inject({method:'GET',url:`${base}/${p.fileId}/revisions/${p.revisionId}/content`,headers:{authorization:`Bearer ${ownerToken}`}})
    expect(read.rawPayload).toEqual(data);expect(read.headers['x-artifact-sha256']).toBe(p.sha256)
    const denied=await app.inject({method:'GET',url:base,headers:{authorization:`Bearer ${deniedToken}`}})
    expect(denied.statusCode).toBe(403)
    const ownerClient = new Client({ name: 'artifact-owner', version: '1' })
    clients.push(ownerClient)
    await ownerClient.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      requestInit: { headers: { authorization: `Bearer ${ownerToken}` } },
    }))
    const artifactArguments = { workspaceId: execution.workspaceId, executionId: execution.id,
      fileId: p.fileId, revisionId: p.revisionId }
    const result = await ownerClient.callTool({ name: 'job_artifact_read', arguments: artifactArguments })
    expect(result.structuredContent).toMatchObject({ artifact: p, content: data.toString('base64') })
    const deniedClient = new Client({ name: 'artifact-reader', version: '1' })
    clients.push(deniedClient)
    await deniedClient.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      requestInit: { headers: { authorization: `Bearer ${deniedToken}` } },
    }))
    const deniedRpc = await deniedClient.callTool({ name: 'job_artifact_read', arguments: artifactArguments })
    expect(deniedRpc.isError).toBe(true)
    const counts=(await pool.query(`select (select count(*) from file_tool_publications)::int as publications,(select count(*) from file_allocations where state='finalized')::int as allocations,(select count(*) from files where scope_kind='job_execution' and conversation_id is null and run_id is null and agent_id is null)::int as explicit_scopes`)).rows[0]
    expect(counts).toEqual({publications:1,allocations:1,explicit_scopes:1})
    const stored=JobExecutionSchema.parse((await pool.query('select record from job_executions where id=$1',[execution.id])).rows[0].record)
    expect(stored.workflow).toBe(null)
    expect(stored.acceptedSpec.computerSelection).toEqual(execution.acceptedSpec.computerSelection)
    await pool.query('update job_fixture_owner set revoked=true')
    await expect(artifacts.publishAccepted(input)).rejects.toMatchObject({code:'JOB_OWNER_REVOKED'})
    await pool.query("update files set state='expired' where file_id=$1",[p.fileId])
    const expired=await app.inject({method:'GET',url:`${base}/${p.fileId}/revisions/${p.revisionId}/content`,headers:{authorization:`Bearer ${ownerToken}`}})
    expect(expired.statusCode).toBe(410)
  })
})
