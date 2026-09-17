import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ManagementActionSchema } from '@graphql/contracts/management'
import { createDatabase } from '../src/infrastructure/database.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { WorkspaceManagementService } from '../src/modules/workspaces/management.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { PostgresRunRepository } from '../src/modules/runs/postgres.js'
import { RunManagementService } from '../src/modules/runs/management.js'
import type { LangGraphWorkflowEngine } from '../src/modules/runs/engine.js'
import { GraphDraftService } from '../src/modules/graph-drafts/service.js'
import { OperatorAgentMutationService } from '../src/modules/workspaces/operatorAgents.js'
import { OperatorLifecycleService } from '../src/modules/workspaces/operatorLifecycle.js'
import { SkillCatalogService } from '../src/modules/skills/catalog.js'
import { VersionHistoryService } from '../src/modules/workflows/historyManagement.js'
import { WorkflowTriggerService } from '../src/modules/workflows/triggerManagement.js'

// Never fall back to DATABASE_URL: this suite requires an explicitly selected,
// empty disposable database. Drop that database after this suite completes.
const connectionString=process.env.MCP_BUNDLE_TEST_DATABASE_URL
const suite=connectionString ? describe : describe.skip
suite('comprehensive MCP persistence on a disposable PostgreSQL database',()=>{
  const database=createDatabase({connectionString:connectionString ?? '',maxConnections:6,connectionTimeoutMs:5000,queryTimeoutMs:5000})
  const directories:string[]=[]
  beforeAll(async()=>{
    const tables=await database.pool.query<{tablename:string}>("select tablename from pg_tables where schemaname=current_schema()")
    if(tables.rows.length) throw new Error('MCP_BUNDLE_TEST_DATABASE_URL must name an EMPTY disposable database; no existing application database was modified.')
    await database.migrate()
  })
  afterAll(async()=>{
    await database.close()
    for(const directory of directories) await rm(directory,{recursive:true,force:true})
  })
  it('persists skills, reuses Agents, restores history, and recovers trigger receipts without a duplicate launch',async()=>{
    const runtime=await mkdtemp(join(tmpdir(),'mcp-runtime-'));directories.push(runtime)
    const project=await mkdtemp(join(tmpdir(),'mcp-project-'));directories.push(project)
    const commands=new PostgresCommandCoordinator(database.pool)
    const access=new PostgresAccessService(database.pool)
    const {principal}=await access.issue({name:'MCP bundle fixture',audience:'operator',grants:[{actions:[...ManagementActionSchema.options],scope:{}}],expiresAt:new Date(Date.now()+600_000)})
    const locations=new WorkspaceLocationService(database.pool,commands,runtime)
    const workspaces=new WorkspaceManagementService(database.pool,commands,locations)
    const workspace=(await workspaces.create(principal,'mcp',{commandId:'fixture-workspace',name:'Comprehensive fixture'})).value.workspace
    await locations.set(principal,'mcp',{workspaceId:workspace.id,commandId:'fixture-location',expectedLocationRevision:0,runnerId:'runner-local',rootPath:project})
    const skills=new SkillCatalogService(database.pool,commands)
    await skills.publish(principal,{workspaceId:workspace.id,skillId:'test-guide',version:'1',commandId:'fixture-skill',name:'Test guide',instructions:'Use deterministic checks.'})
    await expect(skills.publish(principal,{workspaceId:workspace.id,skillId:'test-guide',version:'1',commandId:'different-publish',name:'Overwrite attempt',instructions:'Different content.'})).rejects.toMatchObject({code:'SKILL_VERSION_EXISTS'})
    const agents=new OperatorAgentMutationService(database.pool,commands,{qualifyConfiguration:async value=>({harness:value.harness,version:'fixture',authenticated:true,ready:true,structuredEvents:true,supportsResume:true,supportsCancellation:true,supportsWorkingDirectory:true,supportsStartupPrompt:true,supportedNativeTools:[],supportedSettings:[],unsupportedCapabilities:[]})})
    const agent=(await agents.create(principal,{workspaceId:workspace.id,agentId:'fixture-agent',commandId:'fixture-agent-create',name:'Worker',productRole:'coder',configuration:{harness:'codex',model:'fixture',reasoningEffort:'low',sandbox:'read-only',serviceTier:'standard'},assignedSkills:[{skillId:'test-guide',version:'1'}]})).value
    const history=new VersionHistoryService(database.pool)
    const savedConfiguration=(await history.agent(principal,{workspaceId:workspace.id,agentId:agent.agent.id,versionId:agent.agent.configurationVersionId!})).version
    expect(savedConfiguration.resolvedSkills?.[0]?.instructions).toBe('Use deterministic checks.')
    const workflows=new WorkflowManagementService(database.pool,commands)
    const workflow=(await workflows.create(principal,'mcp',{workspaceId:workspace.id,commandId:'fixture-workflow',name:'Scheduled fixture'})).value.workflow
    const drafts=new GraphDraftService(database.pool,commands)
    const draft=await drafts.open(principal,workspace.id,workflow.id)
    const applied=await drafts.apply(principal,'mcp',{workspaceId:workspace.id,workflowId:workflow.id,draftId:draft.id,commandId:'fixture-attach',expectedRevision:draft.revision,operations:[
      {type:'agent.attach',agentId:agent.agent.id,nodeId:'node',expectedAgentRevision:agent.metadataRevision,expectedConfigurationVersionId:agent.agent.configurationVersionId!},
      {type:'workflow.set_approval',approval:{handler:'user'}},
      {type:'workflow.set_execution_condition',executionCondition:{kind:'schedule'}},
    ]})
    const published=await drafts.save(principal,'mcp',{workspaceId:workspace.id,workflowId:workflow.id,draftId:draft.id,commandId:'fixture-publish',expectedRevision:applied.value.draft.revision})
    expect((await history.workflows(principal,{workspaceId:workspace.id,workflowId:workflow.id,limit:10})).items).toHaveLength(1)
    const restored=await drafts.apply(principal,'mcp',{workspaceId:workspace.id,workflowId:workflow.id,draftId:draft.id,commandId:'fixture-restore',expectedRevision:published.value.draft.revision,operations:[{type:'workflow.restore_version',versionId:published.value.version.id}]})
    expect(restored.value.draft.sourceAgentPins?.[0]?.agentId).toBe(agent.agent.id)
    const republished=await drafts.save(principal,'mcp',{workspaceId:workspace.id,workflowId:workflow.id,draftId:draft.id,commandId:'fixture-republish',expectedRevision:restored.value.draft.revision})
    expect(republished.value.version.id).not.toBe(published.value.version.id)
    const engine={start:vi.fn(async()=>undefined)} as unknown as LangGraphWorkflowEngine
    const workflowRepository=new PostgresWorkflowRepository(database.pool)
    const runRepository=new PostgresRunRepository(database.pool,workflowRepository,locations)
    const runs=new RunManagementService(database.pool,commands,runRepository,engine,locations)
    const triggers=new WorkflowTriggerService(database.pool,commands,runs)
    const enabled=await triggers.update(principal,{workspaceId:workspace.id,workflowId:workflow.id,commandId:'fixture-trigger',expectedRevision:0,workflowVersionId:republished.value.version.id,expectedLocationRevision:1,enabled:true,trigger:{kind:'schedule',startsAt:new Date().toISOString(),intervalSeconds:60,missed:'latest',input:{message:'accepted input'}}})
    await database.pool.query("update workflow_triggers set next_fire_at=now()-interval '1 second' where workflow_id=$1",[workflow.id])
    const errors:unknown[]=[]
    await triggers.tick(error=>errors.push(error))
    await new Promise<void>(resolve=>setImmediate(resolve))
    expect(errors).toEqual([])
    const jobs=await triggers.jobs(principal,{workspaceId:workspace.id,workflowId:workflow.id,limit:10})
    expect(jobs.items).toHaveLength(1)
    expect(jobs.items[0]?.status).toBe('started')
    expect(engine.start).toHaveBeenCalledTimes(1)
    // Simulate losing the acknowledgement after Run admission committed.
    await database.pool.query("update workflow_trigger_jobs set status='leased',run_id=null,lease_owner='lost',lease_expires_at=now()-interval '1 second' where id=$1",[jobs.items[0]!.jobId])
    // Disable must retain a committed job's recoverable receipt, not mark it blocked.
    await triggers.disable(principal,{workspaceId:workspace.id,workflowId:workflow.id,commandId:'fixture-trigger-disable',expectedRevision:enabled.value.revision})
    await access.revoke(principal.id)
    await triggers.tick(error=>errors.push(error))
    expect((await database.pool.query<{status:string}>('select status from workflow_trigger_jobs where id=$1',[jobs.items[0]!.jobId])).rows[0]?.status).toBe('started')
    expect(engine.start).toHaveBeenCalledTimes(1)
    expect(errors).toEqual([])
    await triggers.shutdown()
  },30_000)

  it('archives and restores an unused Agent without deleting configuration history',async()=>{
    const commands=new PostgresCommandCoordinator(database.pool)
    const access=new PostgresAccessService(database.pool)
    const {principal}=await access.issue({name:'Lifecycle fixture',audience:'operator',grants:[{actions:[...ManagementActionSchema.options],scope:{}}],expiresAt:new Date(Date.now()+600_000)})
    const locations=new WorkspaceLocationService(database.pool,commands)
    const workspace=(await new WorkspaceManagementService(database.pool,commands,locations).create(principal,'mcp',{commandId:'lifecycle-workspace',name:'Lifecycle fixture'})).value.workspace
    const agents=new OperatorAgentMutationService(database.pool,commands,{qualifyConfiguration:async value=>({harness:value.harness,version:'fixture',authenticated:true,ready:true,structuredEvents:true,supportsResume:true,supportsCancellation:true,supportsWorkingDirectory:true,supportsStartupPrompt:true,supportedNativeTools:[],supportedSettings:[],unsupportedCapabilities:[]})})
    const agent=(await agents.create(principal,{workspaceId:workspace.id,agentId:'unused-agent',commandId:'unused-agent-create',name:'Unused',productRole:'coder',configuration:{harness:'codex',model:'fixture',reasoningEffort:'low',sandbox:'read-only',serviceTier:'standard'}})).value
    const lifecycle=new OperatorLifecycleService(commands)
    const archived=await lifecycle.agent(principal,{workspaceId:workspace.id,agentId:agent.agent.id,expectedRevision:agent.metadataRevision,commandId:'unused-archive'},true)
    expect(archived.value.archived).toBe(true)
    const restored=await lifecycle.agent(principal,{workspaceId:workspace.id,agentId:agent.agent.id,expectedRevision:archived.value.revision,commandId:'unused-restore'},false)
    expect(restored.value.archived).toBe(false)
    const versions=await database.pool.query('select id from agent_configuration_versions where agent_id=$1',[agent.agent.id])
    expect(versions.rows).toHaveLength(1)
  })
})
