import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { JobArtifactSchema, JobAuthoringChoicesSchema, JobDefinitionSaveSchema, JobDefinitionSchema, JobDefinitionSpecSchema, JobExecutionSchema, JobLogPageSchema, JobStartSchema, JobValidationSchema } from '@graphql/contracts/jobs'
import type { ManagementAction, ManagementPrincipal } from '@graphql/contracts/management'
import { hasAction, isAuthorized, type AuthorizedResource } from '../../../modules/access/policy.js'
import { DomainError } from '../../../modules/errors.js'
import type { JobService } from '../../../modules/jobs/service.js'
import type { PostgresCommandCoordinator } from '../../../modules/commands/postgres.js'
import { toolFailure, toolResult } from '../../shared/results.js'
export const JOB_TOOLS = ['job_choices_get','job_definition_list','job_definition_get','job_definition_save','job_validate','job_start','job_get','job_list','job_cancel','job_logs_read','job_artifacts_list','job_artifact_read'] as const
export type JobToolName = typeof JOB_TOOLS[number]
const actions:Record<JobToolName,ManagementAction> = {
  job_choices_get:'job_definitions:read',job_definition_list:'job_definitions:read',job_definition_get:'job_definitions:read',job_definition_save:'job_definitions:write',job_validate:'job_definitions:read',
  job_start:'jobs:start',job_get:'jobs:read',job_list:'jobs:read',job_cancel:'jobs:cancel',job_logs_read:'job_logs:read',job_artifacts_list:'job_artifacts:read',job_artifact_read:'job_artifacts:read',
}
export interface JobMcpContext {principal:ManagementPrincipal;services:{jobs?:JobService;commands:PostgresCommandCoordinator}}
export function jobToolAvailable(context:JobMcpContext,name:JobToolName,resource:AuthorizedResource={}) {
  return !!context.services.jobs && (Object.keys(resource).length ? isAuthorized(context.principal,actions[name],resource) : hasAction(context.principal,actions[name]))
}
export function jobCapabilities(context:JobMcpContext,resource:AuthorizedResource) {
  return JOB_TOOLS.filter(name=>jobToolAvailable(context,name,resource)).map(name=>({name,actions:[actions[name]],detail:'Workspace-scoped job authority is rechecked live. Accepted specifications and file revisions are immutable. No Agent, provider login or Operator credential enters the build.'}))
}
async function invoke(context:JobMcpContext,name:JobToolName,work:()=>Promise<unknown>) {
  try {return toolResult(await work())} catch(error) {
    if(error instanceof DomainError && error.status===403) await context.services.commands.recordDenied(context.principal.id,'mcp',name,`mcp:${name}`)
    return toolFailure(error)
  }
}
export function registerJobTools(server:McpServer,context:JobMcpContext):void {
  const service=context.services.jobs
  if(!service) return
  const scope=z.object({workspaceId:z.string().min(1)}).strict()
  const execution=scope.extend({executionId:z.string().min(1)}).strict()
  const read={readOnlyHint:true,idempotentHint:true,openWorldHint:false}
  const write={readOnlyHint:false,idempotentHint:true,openWorldHint:false}
  if(jobToolAvailable(context,'job_choices_get')) server.registerTool('job_choices_get',{description:'Read authorized CI source, computer/root and qualified isolation choices without installation or provider login.',inputSchema:scope,outputSchema:JobAuthoringChoicesSchema,annotations:read},input=>invoke(context,'job_choices_get',()=>service.choices(context.principal,input.workspaceId)))
  if(jobToolAvailable(context,'job_definition_list')) server.registerTool('job_definition_list',{description:'List workspace job definitions.',inputSchema:scope,outputSchema:z.object({definitions:z.array(JobDefinitionSchema)}),annotations:read},input=>invoke(context,'job_definition_list',async()=>({definitions:await service.listDefinitions(context.principal,input.workspaceId)})))
  if(jobToolAvailable(context,'job_definition_get')) server.registerTool('job_definition_get',{description:'Read an exact workspace job definition and revision.',inputSchema:scope.extend({definitionId:z.string().min(1)}),outputSchema:z.object({definition:JobDefinitionSchema}),annotations:read},input=>invoke(context,'job_definition_get',async()=>({definition:await service.getDefinition(context.principal,input.workspaceId,input.definitionId)})))
  if(jobToolAvailable(context,'job_definition_save')) server.registerTool('job_definition_save',{description:'Create or edit a job definition with command receipt and optimistic revision. No execution or installation.',inputSchema:JobDefinitionSaveSchema.extend({workspaceId:z.string().min(1)}),outputSchema:z.object({definition:JobDefinitionSchema}),annotations:write},input=>invoke(context,'job_definition_save',async()=>{const {workspaceId,...body}=input;return {definition:await service.saveDefinition(context.principal,'mcp',workspaceId,body)}}))
  if(jobToolAvailable(context,'job_validate')) server.registerTool('job_validate',{description:'Validate job authority/readiness without installation side effects.',inputSchema:scope.extend({spec:JobDefinitionSpecSchema}),outputSchema:JobValidationSchema,annotations:read},input=>invoke(context,'job_validate',()=>service.validate(context.principal,input.workspaceId,input.spec)))
  if(jobToolAvailable(context,'job_start')) server.registerTool('job_start',{description:'Accept one immutable job using the definition revision. Same command/payload returns the same execution, not a rerun.',inputSchema:JobStartSchema.extend({workspaceId:z.string().min(1)}),outputSchema:z.object({execution:JobExecutionSchema}),annotations:write},input=>invoke(context,'job_start',async()=>{const {workspaceId,...body}=input;return {execution:await service.start(context.principal,'mcp',workspaceId,body)}}))
  if(jobToolAvailable(context,'job_get')) server.registerTool('job_get',{description:'Read exact accepted job and separate process, transport and publication facts.',inputSchema:execution,outputSchema:z.object({execution:JobExecutionSchema}),annotations:read},input=>invoke(context,'job_get',async()=>({execution:await service.getExecution(context.principal,input.workspaceId,input.executionId)})))
  if(jobToolAvailable(context,'job_list')) server.registerTool('job_list',{description:'List workspace job executions.',inputSchema:scope,outputSchema:z.object({executions:z.array(JobExecutionSchema)}),annotations:read},input=>invoke(context,'job_list',async()=>({executions:await service.listExecutions(context.principal,input.workspaceId)})))
  if(jobToolAvailable(context,'job_cancel')) server.registerTool('job_cancel',{description:'Persist idempotent cancellation intent. A receipt does not claim the owned process or descendants stopped.',inputSchema:execution.extend({commandId:z.string().min(1)}),outputSchema:z.object({execution:JobExecutionSchema}),annotations:write},input=>invoke(context,'job_cancel',async()=>({execution:await service.cancel(context.principal,'mcp',input.workspaceId,input.executionId,input.commandId)})))
  if(jobToolAvailable(context,'job_logs_read')) server.registerTool('job_logs_read',{description:'Read durable sequenced log chunks; resume with nextCursor. Explicitly reports truncation.',inputSchema:execution.extend({afterSequence:z.number().int().nonnegative().default(0),limit:z.number().int().min(1).max(100).default(50)}),outputSchema:JobLogPageSchema,annotations:read},input=>invoke(context,'job_logs_read',()=>service.readLogs(context.principal,input.workspaceId,input.executionId,input.afterSequence,input.limit)))
  if(jobToolAvailable(context,'job_artifact_read')) server.registerTool('job_artifact_read',{description:'Read bounded exact digest-verified artifact bytes as base64. Expired, missing or corrupt revisions fail; larger artifacts use authenticated HTTP attachment download.',inputSchema:execution.extend({fileId:z.string().min(1),revisionId:z.string().min(1)}),outputSchema:z.object({artifact:JobArtifactSchema,encoding:z.literal('base64'),content:z.string()}),annotations:read},input=>invoke(context,'job_artifact_read',async()=>{
    const value=await service.readArtifact(context.principal,input.workspaceId,input.executionId,input.fileId,input.revisionId)
    if(value.bytes.length>1024*1024) throw new DomainError('JOB_ARTIFACT_TOO_LARGE','Use the exact revision HTTP attachment endpoint for artifacts above 1 MiB.',413)
    return {artifact:value.artifact,encoding:'base64',content:value.bytes.toString('base64')}
  }))
  if(jobToolAvailable(context,'job_artifacts_list')) server.registerTool('job_artifacts_list',{description:'Read canonical exact job artifact file/revision/digest/size and expiry; never substitute latest bytes.',inputSchema:execution,outputSchema:z.object({artifacts:z.array(JobArtifactSchema)}),annotations:read},input=>invoke(context,'job_artifacts_list',async()=>({artifacts:await service.listArtifacts(context.principal,input.workspaceId,input.executionId)})))
}
export async function unavailableJobToolCall(context:JobMcpContext,body:unknown) {
  const call=z.object({jsonrpc:z.literal('2.0'),id:z.union([z.string(),z.number().int()]),method:z.literal('tools/call'),params:z.object({name:z.enum(JOB_TOOLS)}).passthrough()}).passthrough().safeParse(body)
  if(!call.success||jobToolAvailable(context,call.data.params.name)) return undefined
  return {jsonrpc:'2.0' as const,id:call.data.id,result:await invoke(context,call.data.params.name,async()=>{
    throw new DomainError(context.services.jobs?'ACCESS_DENIED':'JOBS_UNAVAILABLE',context.services.jobs?'The caller lacks this job grant.':'Job services are not configured.',context.services.jobs?403:503)
  })}
}
