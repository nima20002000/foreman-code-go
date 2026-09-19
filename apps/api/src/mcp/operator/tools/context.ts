import type { McpServer } from '@modelcontextprotocol/server'
import { OperatorCapabilitiesSchema, OperatorCapabilityInputSchema } from '@graphql/contracts/management'
import { invokeOperatorTool } from '../invoke.js'
import { OPERATOR_TOOL_ACTIONS } from '../catalog.js'
import { operatorToolAvailable,operatorToolRequirements } from '../availability.js'
import type { OperatorRequestContext } from '../types.js'

export const OPERATOR_RUNTIME_LIMITS = [
  {feature:'general_questions_and_forms',state:'unsupported',detail:'Native arbitrary questions/forms do not have a typed durable response path. Approval options are not general answers.'},
  {feature:'advanced_workflow_routing',state:'unsupported',detail:'Executable graphs still require success-only acyclic routing and all joins. Draft schema acceptance is not executable support.'},
  {feature:'run_pause_node_retry_and_steering',state:'unsupported',detail:'Pause, selected-node retry, single-execution Stop, and live worker steering are not implemented. run_retry starts a new full Run.'},
  {feature:'checkpoint_resume',state:'limited',detail:'run_resume only admits healthy already-delivered approval checkpoints. It cannot skip approval or replay unknown side effects.'},
  {feature:'process_exit_confirmation',state:'limited',detail:'run_stop acceptance is not native-process-exit proof; processStopped remains conservative.'},
  {feature:'historical_runs',state:'limited',detail:'Restore history into a new validated current version before running it. Old immutable versions are never edited.'},
  {feature:'resource_deletion',state:'protected',detail:'History-preserving archive/restore is supported; permanent deletion is not exposed.'},
  {feature:'remote_runners_and_host_browsing',state:'unsupported',detail:'Only the local runner is supported. workspace_create can create a named project folder under an explicit parentPath with provisioning, location-update and location-read grants. workspace_folders_list and workspace_folder_create operate only inside configured locations. No arbitrary host browsing or remote dispatch.'},
  {feature:'approval_reassignment',state:'protected',detail:'Read permissions span handlers; response authority stays with the accepted handler. Changing a draft does not take over a running request.'},
  {feature:'operator_self_authorization',state:'protected',detail:'No tools are added for the Operator to answer its own human gates or manage its delegated credential.'},
  {feature:'native_mcp_provisioning',state:'protected',detail:'Native MCP connections can be listed and changes requested. A signed-in user must review changes in Settings. The Operator cannot approve its own request, expose credentials, or approve package installation. Connection requests do not themselves download packages.'},
  {feature:'schedule_delivery',state:'limited',detail:'Interval schedules use the lifecycle polling worker and an expiring principal/delegation chain. No cron or external webhook subscription is implied.'},
  {feature:'opencode_thinking',state:'limited',detail:'The stored thinking flag is metadata-only on the server path; choose an advertised variant for runtime model behavior.'},
] as const

export function registerContextTools(server: McpServer, context: OperatorRequestContext): void {
  if (!operatorToolAvailable(context,'operator_get_capabilities')) return
  server.registerTool('operator_get_capabilities', {
    description: 'Inspect your grants, compatible tool permissions, optional resource scope, and explicit runtime limits. Supply a complete workspace/workflow/run hierarchy for resource checks. This is not a grant or a promise that a specific object exists.',
    inputSchema: OperatorCapabilityInputSchema, outputSchema: OperatorCapabilitiesSchema,
    annotations: {readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  },async(input)=>invokeOperatorTool(context,'operator_get_capabilities',async()=>{
    const resource={...(input.workspaceId?{workspaceId:input.workspaceId}:{}),...(input.workflowId?{workflowId:input.workflowId}:{}),...(input.runId?{runId:input.runId}:{})}
    const tools=OPERATOR_TOOL_ACTIONS.filter((entry)=>operatorToolAvailable(context,entry.name,resource)).map((entry)=>entry.name)
    return {endpoint:'/mcp/operator',audience:'operator',protocol:'2026-07-28',tools,
      principal:{id:context.principal.id,name:context.principal.name,expiresAt:context.principal.expiresAt},
      grants:context.principal.grants,requestedResource:resource,
      requirements:tools.map((name)=>({name,actions:operatorToolRequirements(name).map((item)=>item.action),
        detail:name === 'workspace_create' ? 'Creating parentPath/name additionally requires global workspace_locations:provision, workspace_locations:update and workspace_locations:read grants. Read workspace_defaults_get for the default parentPath; omit parentPath only for an unconfigured workspace.' : 'Requirements are scoped independently. Staged/shared Agent writes, skill contents, and enabling triggers can require additional permissions; services revalidate every concrete operation.'})),
      runtimeLimits:[...OPERATOR_RUNTIME_LIMITS],
      workerToolsMcp:{implemented:context.services.workerToolsMcpImplemented===true,endpoint:'/mcp/tools'}}
  }))
}
