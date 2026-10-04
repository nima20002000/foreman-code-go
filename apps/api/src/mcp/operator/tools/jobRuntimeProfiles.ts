import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { JobRuntimeApprovalSchema, JobRuntimeProfileSchema,JobRuntimeProfileListSchema, JobRuntimeProfileSaveSchema, JobRuntimeQualificationReadSchema, JobRuntimeQualificationRequestSchema } from '@foreman-code/contracts/job-runtime'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { hasAction, isAuthorized, type AuthorizedResource } from '../../../modules/access/policy.js'
import type { JobRuntimeProfiles } from '../../../modules/jobs/runtimeProfiles.js'
import type { PostgresCommandCoordinator } from '../../../modules/commands/postgres.js'
import { DomainError } from '../../../modules/errors.js'
import { toolFailure, toolResult } from '../../shared/results.js'
export const JOB_RUNTIME_TOOLS=['job_runtime_profile_list','job_runtime_profile_save','job_runtime_qualification_request','job_runtime_qualification_run','job_runtime_qualification_get'] as const
export type JobRuntimeToolName=typeof JOB_RUNTIME_TOOLS[number]
interface Context {principal:ManagementPrincipal;services:{jobRuntimeProfiles?:JobRuntimeProfiles;commands:PostgresCommandCoordinator}}
const action=(name:JobRuntimeToolName)=>name==='job_runtime_profile_list'||name==='job_runtime_qualification_get'?'job_definitions:read' as const:'job_definitions:write' as const
export function jobRuntimeToolAvailable(context:Context,name:JobRuntimeToolName,resource:AuthorizedResource={}) {
  return !!context.services.jobRuntimeProfiles&&(Object.keys(resource).length?isAuthorized(context.principal,action(name),resource):hasAction(context.principal,action(name)))
}
export function jobRuntimeCapabilities(context:Context,resource:AuthorizedResource) {
  return JOB_RUNTIME_TOOLS.filter(name=>jobRuntimeToolAvailable(context,name,resource)).map(name=>({name,actions:[action(name)],detail:'Read/save existing-root CI policy metadata and request/read/run an exactly human-approved qualification. Physical approval is human-only; GET performs no probe or installation.'}))
}
async function invoke(context:Context,name:JobRuntimeToolName,work:()=>Promise<unknown>) {
  try{return toolResult(await work())}catch(error){
    if(error instanceof DomainError&&error.status===403)await context.services.commands.recordDenied(context.principal.id,'mcp',name,`mcp:${name}`)
    return toolFailure(error)
  }
}
export function registerJobRuntimeTools(server:McpServer,context:Context) {
  const service=context.services.jobRuntimeProfiles
  if(!service)return
  const scope=z.object({workspaceId:z.string().min(1)}).strict(),approval=scope.extend({approvalId:z.string().uuid()})
  const read={readOnlyHint:true,idempotentHint:true,openWorldHint:false},write={readOnlyHint:false,idempotentHint:true,openWorldHint:false}
  if(jobRuntimeToolAvailable(context,'job_runtime_profile_list'))server.registerTool('job_runtime_profile_list',{description:'Read existing CI policy profiles, exact qualification approval fingerprints and metadata readiness. Never probes, approves or installs a runtime. Physical approval requires a local human decision in the app.',inputSchema:scope,outputSchema:JobRuntimeProfileListSchema,annotations:read},input=>invoke(context,'job_runtime_profile_list',()=>service.list(context.principal,input.workspaceId)))
  if(jobRuntimeToolAvailable(context,'job_runtime_profile_save'))server.registerTool('job_runtime_profile_save',{description:'Save a revisioned CI policy for an existing approved root. Caller cannot declare qualification evidence or readiness.',inputSchema:JobRuntimeProfileSaveSchema.extend({workspaceId:z.string().min(1)}),outputSchema:z.object({profile:JobRuntimeProfileSchema}),annotations:write},input=>invoke(context,'job_runtime_profile_save',async()=>{const{workspaceId,...body}=input;return {profile:await service.save(context.principal,'mcp',workspaceId,body)}}))
  if(jobRuntimeToolAvailable(context,'job_runtime_qualification_request'))server.registerTool('job_runtime_qualification_request',{description:'Capture exact installed candidate metadata for human approval. This does not probe, install or approve the runtime.',inputSchema:JobRuntimeQualificationRequestSchema.extend({workspaceId:z.string().min(1)}),outputSchema:z.object({approval:JobRuntimeApprovalSchema}),annotations:write},input=>invoke(context,'job_runtime_qualification_request',async()=>{const{workspaceId,...body}=input;return {approval:await service.requestQualification(context.principal,'mcp',workspaceId,body)}}))
  if(jobRuntimeToolAvailable(context,'job_runtime_qualification_run'))server.registerTool('job_runtime_qualification_run',{description:'Run the original exact human-approved qualification through the guarded host owner. Never self-approves or retries an unresolved physical operation.',inputSchema:approval.extend({commandId:z.string().min(1)}),outputSchema:z.object({profile:JobRuntimeProfileSchema}),annotations:write},input=>invoke(context,'job_runtime_qualification_run',async()=>({profile:await service.qualify(context.principal,'mcp',input.workspaceId,input.commandId,input.approvalId)})))
  if(jobRuntimeToolAvailable(context,'job_runtime_qualification_get'))server.registerTool('job_runtime_qualification_get',{description:'Read original approval, retained Main native admission, measured evidence and current pure readiness. Admission records ownership and is not qualification evidence. Approval is human-only and cannot be granted via MCP.',inputSchema:approval,outputSchema:JobRuntimeQualificationReadSchema,annotations:read},input=>invoke(context,'job_runtime_qualification_get',()=>service.getQualification(context.principal,input.workspaceId,input.approvalId)))
}

export async function unavailableJobRuntimeToolCall(context:Context,body:unknown) {
  const call=z.object({jsonrpc:z.literal('2.0'),id:z.union([z.string(),z.number().int()]),method:z.literal('tools/call'),params:z.object({name:z.enum(JOB_RUNTIME_TOOLS)}).passthrough()}).passthrough().safeParse(body)
  if(!call.success||jobRuntimeToolAvailable(context,call.data.params.name))return undefined
  return {jsonrpc:'2.0' as const,id:call.data.id,result:await invoke(context,call.data.params.name,async()=>{throw new DomainError(context.services.jobRuntimeProfiles?'ACCESS_DENIED':'JOB_RUNTIME_UNAVAILABLE','CI runtime metadata or the required grant is unavailable.',context.services.jobRuntimeProfiles?403:503)})}
}
