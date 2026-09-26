import type { McpServer } from '@modelcontextprotocol/server'
import { OperatorCapabilityInputSchema } from '@graphql/contracts/management'
import { CurrentOperatorCapabilitiesSchema, CURRENT_WORKFLOW_TOOLS, CANONICAL_RUN_GRAPH_MCP_TOOLS, RUN_INSPECTION_TOOLS } from '@graphql/contracts/wave25'
import { currentWorkflowAvailable, currentWorkflowRequirements, type CurrentWorkflowOperation } from '../../../modules/workflows/currentWorkflowPolicy.js'
import { runInspectionToolAvailable, runInspectionRequirements } from './runInspection.js'
import { runGraphToolAvailable } from './runGraph.js'
import { hasAction, isAuthorized } from '../../../modules/access/policy.js'
import { invokeOperatorTool } from '../invoke.js'
import { OPERATOR_TOOL_ACTIONS } from '../catalog.js'
import { operatorToolAvailable,operatorToolRequirements } from '../availability.js'
import type { OperatorRequestContext } from '../types.js'

export const OPERATOR_RUNTIME_LIMITS = [
  {feature:'current_workflow_semantics',state:'limited',detail:'One semantics-3 authoring/read/Start contract covers ordinary, parallel/all-required, conditional/approval and optional bounded repeat. Ordinary definitions omit repeat. Read workflow_authoring_capabilities_v3 for separately composed native Start/Stop readiness. Stage/Discard do not execute; Stop-and-save waits for exact settlement.'},
  {feature:'general_questions_and_forms',state:'unsupported',detail:'Native arbitrary questions/forms do not have a typed durable response path. Approval options are not general answers.'},
  {feature:'named_workflow_routing',state:'limited',detail:'Explicit named outcomes, acyclic execution relationships and all-required joins share the current validator. Arbitrary cycles, nested repeats, inferred routes and unknown outcomes are rejected. Valid authoring is not native admission.'},
  {feature:'run_pause_node_retry_and_steering',state:'unsupported',detail:'Pause, selected-node retry, single-execution Stop, and live worker steering are not implemented. A deliberate new full Run uses the current pinned run_start contract; the old unpinned retry adapter is retired.'},
  {feature:'checkpoint_resume',state:'limited',detail:'Automatic current checkpoint continuation requires A’s exact native approval receipts. The old manual run_resume adapter is retired; no caller can skip approval.'},
  {feature:'process_exit_confirmation',state:'limited',detail:'run_stop acceptance is not native-process-exit proof; processStopped remains conservative.'},
  {feature:'historical_runs',state:'limited',detail:'Restore history into a new validated current version before running it. Old immutable versions are never edited.'},
  {feature:'resource_deletion',state:'protected',detail:'History-preserving archive/restore is supported; permanent deletion is not exposed.'},
  {feature:'remote_runners_and_host_browsing',state:'unsupported',detail:'Only the local runner is supported. workspace_create can create a named project folder under an explicit parentPath with provisioning, location-update and location-read grants. workspace_folders_list and workspace_folder_create operate only inside app-managed workspace storage; Desktop and runtime storage are not workspace destinations. No arbitrary host browsing or remote dispatch.'},
  {feature:'approval_reassignment',state:'protected',detail:'Read permissions span handlers; response authority stays with the accepted handler. Changing a draft does not take over a running request.'},
  {feature:'operator_self_authorization',state:'protected',detail:'No tools are added for the Operator to answer its own human gates or manage its delegated credential.'},
  {feature:'native_mcp_provisioning',state:'protected',detail:'Native MCP connections can be listed and changes requested, including installation, removal, disabling, and enabling of exact Operator and read-only Linear presets. A signed-in owner applies changes in Harness Settings, including one-click preset actions. The Operator cannot approve its own request, expose credentials, or approve package installation. Connection requests do not download packages.'},
  {feature:'codex_plugins',state:'protected',detail:'Installed and available Codex plugins and verified bundle contents can be read through Operator MCP. Installing or removing a plugin is human-only in Codex Harness Settings because plugins can add executable hooks, skills, and external MCP access; Operator cannot request or approve plugin writes.'},
  {feature:'schedule_delivery',state:'unsupported',detail:'Retired unpinned trigger admission is not active. This current delivery exposes only explicit pinned manual run_start; no scheduled or event Start is promised.'},
  {feature:'opencode_thinking',state:'limited',detail:'The stored thinking flag is metadata-only on the server path; choose an advertised variant for runtime model behavior.'},
] as const

export function registerContextTools(server: McpServer, context: OperatorRequestContext): void {
  if (!operatorToolAvailable(context,'operator_get_capabilities')) return
  server.registerTool('operator_get_capabilities', {
    description: 'Inspect your grants, compatible tool permissions, optional resource scope, and explicit runtime limits. Supply a complete workspace/workflow/run hierarchy for resource checks. This is not a grant or a promise that a specific object exists.',
    inputSchema: OperatorCapabilityInputSchema, outputSchema: CurrentOperatorCapabilitiesSchema,
    annotations: {readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  },async(input)=>invokeOperatorTool(context,'operator_get_capabilities',async()=>{
    const resource={...(input.workspaceId?{workspaceId:input.workspaceId}:{}),...(input.workflowId?{workflowId:input.workflowId}:{}),...(input.runId?{runId:input.runId}:{})}
    const ordinary=OPERATOR_TOOL_ACTIONS.filter((entry)=>operatorToolAvailable(context,entry.name,resource)).map((entry)=>entry.name)
    const current = (Object.keys(CURRENT_WORKFLOW_TOOLS) as CurrentWorkflowOperation[]).filter((operation) =>
      !!context.services.workflows?.current && currentWorkflowAvailable(context.principal, operation, resource))
    const graph = context.services.runGraph && (Object.keys(resource).length
      ? isAuthorized(context.principal, 'runs:read', resource) : hasAction(context.principal, 'runs:read'))
      ? Object.values(CANONICAL_RUN_GRAPH_MCP_TOOLS).filter((name) => runGraphToolAvailable(context, name)) : []
    const inspection = Object.values(RUN_INSPECTION_TOOLS).filter((name) => runInspectionToolAvailable(context, name, resource))
    const tools = [...ordinary, ...current.map((operation) => CURRENT_WORKFLOW_TOOLS[operation]), ...graph, ...inspection]
    return {endpoint:'/mcp/operator',audience:'operator',protocol:'2026-07-28',tools,
      principal:{id:context.principal.id,name:context.principal.name,expiresAt:context.principal.expiresAt},
      grants:context.principal.grants,requestedResource:resource,
      requirements:[...ordinary.map((name)=>({name,actions:operatorToolRequirements(name,resource).map((item)=>item.action),
        detail:name === 'workspace_create' ? 'Creating parentPath/name additionally requires global workspace_locations:provision, workspace_locations:update and workspace_locations:read grants. Read workspace_defaults_get for the default parentPath; omit parentPath only for an unconfigured workspace.' : 'Requirements are scoped independently. Staged/shared Agent writes, skill contents, and enabling triggers can require additional permissions; services revalidate every concrete operation.'})),
        ...current.map((operation) => ({ name: CURRENT_WORKFLOW_TOOLS[operation],
          actions: currentWorkflowRequirements[operation].map((item) => item.action),
          detail: 'Current V3 only. Concrete services recheck all scope, pin and settlement requirements; Stop also needs each affected Run grant.' })),
        ...graph.map((name) => ({ name, actions: ['runs:read' as const], detail: 'Exact current Run/workflow/version scope. Metadata reads do not grant execution authority.' })),
        ...inspection.map((name) => ({ name, actions: runInspectionRequirements(name),
          detail: 'Private bounded V3 Run inspection. runs:read is checked on the exact persisted Run; run_version_get additionally requires workflows:read on its workflow. Read-only grants are sufficient; no execution authority is conferred.' }))],
      runtimeLimits:[...OPERATOR_RUNTIME_LIMITS],
      workerToolsMcp:{implemented:context.services.workerToolsMcpImplemented===true,endpoint:'/mcp/tools'}}
  }))
}
