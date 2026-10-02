import { runHistoryCapabilityLimit } from './runHistory.js'
import type { McpServer } from '@modelcontextprotocol/server'
import { OperatorCapabilityInputSchema } from '@graphql/contracts/management'
import { CURRENT_WORKFLOW_TOOLS, CANONICAL_RUN_GRAPH_MCP_TOOLS, RUN_INSPECTION_TOOLS } from '@graphql/contracts/wave25'
import { currentWorkflowAvailable, currentWorkflowRequirements, type CurrentWorkflowOperation } from '../../../modules/workflows/currentWorkflowPolicy.js'
import { runInspectionToolAvailable, runInspectionRequirements } from './runInspection.js'
import { runGraphToolAvailable } from './runGraph.js'
import { ScheduleOperatorCapabilitiesSchema, workflowScheduleCapabilities } from './workflowSchedules.js'
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
  {feature:'trusted_device_owner_approval',state:'protected',detail:'Operator can discover, inspect, check and read trusted device connections, and configure consent using an existing exact browser owner approval. Requesting, approving and revoking that human approval requires the signed-in owner in the browser; settings:update never permits self-approval or grants agent execution permissions.'},
  {feature:'operator_self_authorization',state:'protected',detail:'No tools are added for the Operator to answer its own human gates or manage its delegated credential.'},
  {feature:'native_mcp_provisioning',state:'protected',detail:'Native MCP connections can be listed and changes requested, including installation, removal, disabling, and enabling of the exact GraphQL (one connection for every role) and read-only Linear presets. A signed-in owner applies changes in Harness Settings, including one-click preset actions. The Operator cannot approve its own request, expose credentials, or approve package installation. Connection requests do not download packages.'},
  {feature:'codex_plugins',state:'protected',detail:'Installed and available Codex plugins and verified bundle contents can be read through Operator MCP. Installing or removing a plugin is human-only in Codex Harness Settings because plugins can add executable hooks, skills, and external MCP access; Operator cannot request or approve plugin writes.'},
  {feature:'schedule_delivery',state:'unsupported',detail:'Retired unpinned trigger admission is not active. This current delivery exposes only explicit pinned manual run_start; no scheduled or event Start is promised.'},
  {feature:'skills',state:'limited',detail:'Skills are workspace-owned Markdown instruction text managed with skill_list/get/versions_list/create/update/archive. Every save creates an immutable version; Agents pin exact versions through agent_create/agent_update or the board and never follow later edits. Skill text is delivered as native Agent instructions, never as tool grants. Packages, folders, scripts, URLs and includes are not supported. Persistent instructions plus skills are limited to 512 KiB per Agent.'},
  {feature:'opencode_thinking',state:'limited',detail:'The stored thinking flag is metadata-only on the server path; choose an advertised variant for runtime model behavior.'},
] as const

export function registerContextTools(server: McpServer, context: OperatorRequestContext): void {
  if (!operatorToolAvailable(context,'operator_get_capabilities')) return
  server.registerTool('operator_get_capabilities', {
    description: 'Inspect your grants, compatible tool permissions, optional resource scope, and explicit runtime limits. Supply a complete workspace/workflow/run hierarchy for resource checks. This is not a grant or a promise that a specific object exists.',
    inputSchema: OperatorCapabilityInputSchema, outputSchema: ScheduleOperatorCapabilitiesSchema,
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
    const schedules = workflowScheduleCapabilities(context, resource)
    const scheduleRuntime = context.services.runs?.scheduleAvailability?.()
    const runtimeLimits = OPERATOR_RUNTIME_LIMITS.map((limit) =>
      limit.feature === 'schedule_delivery' && scheduleRuntime?.configured
        ? { feature: limit.feature, state: 'limited' as const,
          detail: 'The API dispatcher uses the same pinned Start and engine as manual Runs. It admits only the latest due occurrence within five minutes, skips overlapping scheduled Runs, and pins the latest saved workflow. Live owner grants and native runtime readiness are rechecked. Retired unpinned triggers and event Start remain unavailable. '
            + (scheduleRuntime.runtimeAdmission ? 'Timed Run admission is available.'
              : 'Timed Run admission is paused until native runtime readiness returns.') }
        : limit)
    const tools = [...ordinary, ...current.map((operation) => CURRENT_WORKFLOW_TOOLS[operation]), ...graph, ...inspection, ...schedules.map((entry) => entry.name)]
    return {endpoint:'/mcp',audience:'operator',protocol:'2026-07-28',tools,
      principal:{id:context.principal.id,name:context.principal.name,expiresAt:context.principal.expiresAt},
      grants:context.principal.grants,requestedResource:resource,
      requirements:[...ordinary.map((name)=>({name,actions:operatorToolRequirements(name,resource).map((item)=>item.action),
        detail:name.startsWith('resource_telemetry_') ? 'The listed actions are alternatives: computer reads require an explicit unscoped devices:metrics:read grant; owned reads require the relevant Run/Job/conversation grant. The same service rechecks the exact live resource, shared owners, attribution and collector generation on every call.' : name === 'workspace_create' ? 'Creating parentPath/name additionally requires global workspace_locations:provision, workspace_locations:update and workspace_locations:read grants. Read workspace_defaults_get for the default parentPath; omit parentPath only for an unconfigured workspace.' : 'Requirements are scoped independently. Staged/shared Agent writes, skill contents, and enabling triggers can require additional permissions; services revalidate every concrete operation.'})),
        ...current.map((operation) => ({ name: CURRENT_WORKFLOW_TOOLS[operation],
          actions: currentWorkflowRequirements[operation].map((item) => item.action),
          detail: 'Current V3 only. Concrete services recheck all scope, pin and settlement requirements; Stop also needs each affected Run grant.' })),
        ...graph.map((name) => ({ name, actions: ['runs:read' as const], detail: 'Exact current Run/workflow/version scope. Metadata reads do not grant execution authority.' })),
        ...inspection.map((name) => ({ name, actions: runInspectionRequirements(name),
          detail: 'Private bounded V3 Run inspection. runs:read is checked on the exact persisted Run; run_version_get additionally requires workflows:read on its workflow. Read-only grants are sufficient; no execution authority is conferred.' })), ...schedules],
      runtimeLimits:[...runtimeLimits, runHistoryCapabilityLimit(context), ...(schedules.length ? [{ feature: 'schedule_persistence', state: 'limited' as const,
        detail: 'Schedule CRUD and bounded occurrence history have HTTP/MCP parity. '
          + (scheduleRuntime?.configured ? 'Timed Run admission is composed; see schedule_delivery for policy and readiness. '
            : 'This persistence-only composition has no dispatcher or timed Run admission. ')
          + 'Clear/paging/discovery compositions await shared-contract follow-up.' }] : []), ...(context.services.fileReferences ? [{
        feature: 'permanent_reference_files', state: 'limited' as const,
        detail: 'Permanent references support reference_files_list, reference_file_read, reference_file_add and reference_file_remove through tools/list. Read requires the scope-specific workspaces:read or workflows:read grant; add/remove additionally require the matching update grant. Worker access is not granted. These backend extension names are not in this frozen capability tools enum; use tools/list for caller-filtered schemas. Agent access resolution is separate.',
      }] : [])],
      workerToolsMcp:{implemented:context.services.workerToolsMcpImplemented===true,endpoint:'/mcp'}}
  }))
}
