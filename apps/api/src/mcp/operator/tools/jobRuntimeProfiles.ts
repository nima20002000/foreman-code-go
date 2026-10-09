import { JobRuntimeApprovalRecordSchema, JobRuntimeProfileRecordSchema, JobRuntimeProfileListRecordSchema,
  JobRuntimeProfileSaveRecordSchema, JobRuntimeQualificationReadRecordSchema }
  from '@foreman-code/contracts/job-verification-runtime'
import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { JobRuntimeQualificationRequestSchema } from '@foreman-code/contracts/job-runtime'
import type { ManagementAction, ManagementPrincipal } from '@foreman-code/contracts/management'
import { hasAction, isAuthorized, type AuthorizedResource } from '../../../modules/access/policy.js'
import type { JobRuntimeProfiles } from '../../../modules/jobs/runtimeProfiles.js'
import { BUILD_COMPUTER_PREPARE_ACTIONS, type CiRuntimeProvisioner } from '../../../modules/jobs/ciRuntimeProvisioner.js'
import { BuildComputerPrepareGetInputSchema, BuildComputerPrepareInputSchema, BuildComputerPrepareStatusSchema } from '@foreman-code/contracts'
import type { PostgresCommandCoordinator } from '../../../modules/commands/postgres.js'
import { DomainError } from '../../../modules/errors.js'
import { toolFailure, toolResult } from '../../shared/results.js'
export const JOB_RUNTIME_TOOLS=['job_runtime_profile_list','job_runtime_profile_save','job_runtime_qualification_request','job_runtime_qualification_run','job_runtime_qualification_get','build_computer_prepare','build_computer_prepare_get'] as const
export type JobRuntimeToolName=typeof JOB_RUNTIME_TOOLS[number]
interface Context {principal:ManagementPrincipal;services:{jobRuntimeProfiles?:JobRuntimeProfiles;ciRuntime?:CiRuntimeProvisioner;commands:PostgresCommandCoordinator}}
const action=(name:JobRuntimeToolName)=>name==='job_runtime_profile_list'||name==='job_runtime_qualification_get'||name==='build_computer_prepare_get'?'job_definitions:read' as const:'job_definitions:write' as const
function requiredActions(name: JobRuntimeToolName): ManagementAction[] {
  if (name === 'job_runtime_profile_save') return [action(name), 'sources:read', 'source_roots:read']
  if (name === 'build_computer_prepare') return [...BUILD_COMPUTER_PREPARE_ACTIONS]
  return [action(name)]
}
export function jobRuntimeToolAvailable(context:Context,name:JobRuntimeToolName,resource:AuthorizedResource={}) {
  if (name.startsWith('build_computer_prepare') && !context.services.ciRuntime) return false
  return !!context.services.jobRuntimeProfiles && requiredActions(name).every(required =>
    Object.keys(resource).length ? isAuthorized(context.principal, required, resource) : hasAction(context.principal, required))
}
export function jobRuntimeCapabilities(context:Context,resource:AuthorizedResource) {
  return JOB_RUNTIME_TOOLS.filter(name=>jobRuntimeToolAvailable(context,name,resource)).map(name=>({name,actions:requiredActions(name),detail:'Read/save existing-root CI policy metadata, capture an installed candidate on a paired, authorized computer and run or reconcile its qualification with the original command. There is no approval step; GET performs no probe or installation.'}))
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
  if(jobRuntimeToolAvailable(context,'job_runtime_profile_list'))server.registerTool('job_runtime_profile_list',{description:'Read existing CI policy profiles, captured qualification fingerprints and metadata readiness. Never probes or installs a runtime. Protected host configuration capture/refresh is a stopped-Worker installer action, unavailable through MCP.',inputSchema:scope,outputSchema:JobRuntimeProfileListRecordSchema,annotations:read},input=>invoke(context,'job_runtime_profile_list',()=>service.list(context.principal,input.workspaceId)))
  if(jobRuntimeToolAvailable(context,'job_runtime_profile_save'))server.registerTool('job_runtime_profile_save',{description:'Save a revisioned CI policy for an existing approved root. Build and verification records retain their formats. Verification saves the approved source commit, offline network policy and reviewed 24-hour lifetime; activation requires measured runtime resources. Caller cannot declare review, qualification evidence or readiness.',inputSchema:JobRuntimeProfileSaveRecordSchema.extend({workspaceId:z.string().min(1)}),outputSchema:z.object({profile:JobRuntimeProfileRecordSchema}),annotations:write},input=>invoke(context,'job_runtime_profile_save',async()=>{const{workspaceId,...body}=input;return {profile:await service.save(context.principal,'mcp',workspaceId,body)}}))
  if(jobRuntimeToolAvailable(context,'job_runtime_qualification_request'))server.registerTool('job_runtime_qualification_request',{description:'Capture the exact installed candidate on a paired, authorized computer; run job_runtime_qualification_run next, with no approval step. This does not probe or install the runtime. Verification candidates bind the saved source commit and profile; another commit requires a new capture. Native entry uses the original guarded runtime owner.',inputSchema:JobRuntimeQualificationRequestSchema.extend({workspaceId:z.string().min(1)}),outputSchema:z.object({approval:JobRuntimeApprovalRecordSchema}),annotations:write},input=>invoke(context,'job_runtime_qualification_request',async()=>{const{workspaceId,...body}=input;return {approval:await service.requestQualification(context.principal,'mcp',workspaceId,body)}}))
  if(jobRuntimeToolAvailable(context,'job_runtime_qualification_run'))server.registerTool('job_runtime_qualification_run',{description:'Run the captured qualification through its guarded host owner. Verification qualification requires jobs:start and job_artifacts:read in addition to job_definitions:write, and retains ordinary-suite and interruption reports as readable canonical Jobs. Long operations retain their start and result in the worker journal. Retry the same command to reconcile its result and cleanup; reconciliation does not launch another diagnostic.',inputSchema:approval.extend({commandId:z.string().min(1)}),outputSchema:z.object({profile:JobRuntimeProfileRecordSchema}),annotations:write},input=>invoke(context,'job_runtime_qualification_run',async()=>({profile:await service.qualify(context.principal,'mcp',input.workspaceId,input.commandId,input.approvalId)})))
  if(jobRuntimeToolAvailable(context,'job_runtime_qualification_get'))server.registerTool('job_runtime_qualification_get',{description:'Read the original captured candidate, retained Main native admission, measured evidence and current pure readiness. Failed suites retain the exit code and report Job executionId in readiness reasons; read those reports with job_artifacts_list and job_artifact_read. Admission records ownership and is not qualification evidence.',inputSchema:approval,outputSchema:JobRuntimeQualificationReadRecordSchema,annotations:read},input=>invoke(context,'job_runtime_qualification_get',()=>service.getQualification(context.principal,input.workspaceId,input.approvalId)))
  const ci=context.services.ciRuntime
  if(ci&&jobRuntimeToolAvailable(context,'build_computer_prepare'))server.registerTool('build_computer_prepare',{description:'Prepare a paired build computer\'s CI runtime for a commit (default: the workspace repository\'s default branch), with no human step. The computer fetches the commit from the workspace GitHub repository, builds its offline package seed and verification image, Main moves every verification profile on that computer to the commit and image, the computer refreshes its protected runtime and restarts its Worker, and Main requalifies each profile. Runs in the background; follow it with build_computer_prepare_get. One preparation per physical computer across workspaces. A different command while one runs reports CI_RUNTIME_BUSY; retry it later. The same command resumes or reads its persisted operation after Main restarts. Requires job_definitions:read, job_definitions:write, sources:approve, sources:read, source_roots:bind, source_roots:read, workspace_locations:read, jobs:start and job_artifacts:read in the workspace. ci_run starts this automatically when a commit changes dependency files.',inputSchema:BuildComputerPrepareInputSchema,outputSchema:BuildComputerPrepareStatusSchema,annotations:{...write,openWorldHint:true}},input=>invoke(context,'build_computer_prepare',()=>ci.start(context.principal,'mcp',input)))
  if(ci&&jobRuntimeToolAvailable(context,'build_computer_prepare_get'))server.registerTool('build_computer_prepare_get',{description:'Read the CI runtime preparation of the computer that holds this verification profile: approving, preparing (with its build stage), binding, refreshing, qualifying, qualified or failed (with the reason), and each profile\'s revision and status. Reads persisted progress across Main restarts; idle when this workspace has no preparation for the computer. Requires job_definitions:read.',inputSchema:BuildComputerPrepareGetInputSchema,outputSchema:BuildComputerPrepareStatusSchema,annotations:read},input=>invoke(context,'build_computer_prepare_get',()=>ci.get(context.principal,input)))
}

export async function unavailableJobRuntimeToolCall(context:Context,body:unknown) {
  const call=z.object({jsonrpc:z.literal('2.0'),id:z.union([z.string(),z.number().int()]),method:z.literal('tools/call'),params:z.object({name:z.enum(JOB_RUNTIME_TOOLS)}).passthrough()}).passthrough().safeParse(body)
  if(!call.success||jobRuntimeToolAvailable(context,call.data.params.name))return undefined
  return {jsonrpc:'2.0' as const,id:call.data.id,result:await invoke(context,call.data.params.name,async()=>{throw new DomainError(context.services.jobRuntimeProfiles?'ACCESS_DENIED':'JOB_RUNTIME_UNAVAILABLE','CI runtime metadata or the required grant is unavailable.',context.services.jobRuntimeProfiles?403:503)})}
}
