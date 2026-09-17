import type pg from 'pg'
import { createHash } from 'node:crypto'
import { WorkflowRunSchema } from '@graphql/contracts'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import { requireAuthorization } from '../access/policy.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { LangGraphWorkflowEngine } from './engine.js'
import type { RunManagementService } from './management.js'
import { DomainError } from '../errors.js'

export class OperatorRunControls {
  constructor(private readonly pool:pg.Pool,private readonly commands:PostgresCommandCoordinator,
    private readonly engine:LangGraphWorkflowEngine,private readonly runs:RunManagementService) {}
  private async read(principal:ManagementPrincipal,input:{workspaceId:string;runId:string}) {
    const rows=await this.pool.query<{record:unknown}>('select record from runs where workspace_id=$1 and id=$2',[input.workspaceId,input.runId])
    if (!rows.rows[0]) throw new DomainError('RUN_NOT_FOUND','The Run was not found.',404)
    const run=WorkflowRunSchema.parse(rows.rows[0].record)
    requireAuthorization(principal,'runs:read',{workspaceId:input.workspaceId,workflowId:run.workflowId,runId:input.runId})
    return run
  }
  async resume(principal:ManagementPrincipal,input:{workspaceId:string;runId:string;commandId:string}) {
    const run=await this.read(principal,input)
    requireAuthorization(principal,'runs:resume',{workspaceId:input.workspaceId,workflowId:run.workflowId,runId:input.runId})
    requireAuthorization(principal,'workspace_locations:read',{workspaceId:input.workspaceId})
    return this.commands.execute({principal,source:'mcp',operation:'run.resume',commandId:input.commandId,dedicatedConnection:true,
      targetKey:`run:${input.runId}`,payload:input,perform:async()=>{
        // The engine admits only healthy, already-delivered approval checkpoints.
        // This neither approves a request nor replays an interrupted native turn.
        await this.engine.resume(input.runId)
        return {runId:input.runId,status:'reconciled' as const}
      }})
  }
  async retry(principal:ManagementPrincipal,input:{workspaceId:string;runId:string;commandId:string;workflowVersionId:string;expectedLocationRevision:number}) {
    const run=await this.read(principal,input)
    requireAuthorization(principal,'runs:start',{workspaceId:input.workspaceId,workflowId:run.workflowId})
    requireAuthorization(principal,'workspace_locations:read',{workspaceId:input.workspaceId})
    if (run.executionState!=='completed' || !['failed','canceled'].includes(run.outcome)) {
      throw new DomainError('RUN_RETRY_UNSUPPORTED','Only terminal failed/canceled Runs can be retried as a new full Run.',409)
    }
    const result=await this.commands.execute({principal,source:'mcp',operation:'run.retry',commandId:input.commandId,dedicatedConnection:true,
      targetKey:`run:${input.runId}`,payload:input,perform:()=>this.runs.start(principal,'mcp',{
        workspaceId:input.workspaceId,workflowId:run.workflowId,workflowVersionId:input.workflowVersionId,
        expectedLocationRevision:input.expectedLocationRevision,
        commandId:`retry:${createHash('sha256').update(JSON.stringify([input.runId,input.commandId])).digest('hex')}`,input:run.input,
      })})
    return {...result.value,replayed:result.replayed || result.value.replayed}
  }
}
