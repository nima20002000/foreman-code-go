import { RUN_HISTORY_TOOLS, runHistoryCapabilityLimit, runHistoryToolAvailable } from './runHistory.js'
import { FILE_REFERENCE_TOOL_NAMES, fileReferenceToolAvailable } from './fileReferences.js'
import { FILE_RETENTION_TOOL_NAMES, fileRetentionToolAvailable } from './fileRetention.js'
import type { McpServer } from '@modelcontextprotocol/server'
import { OperatorCompactCapabilitiesSchema } from '@foreman-code/contracts/operator-mcp'
import { OperatorCapabilityInputSchema } from '@foreman-code/contracts/management'
import { CURRENT_WORKFLOW_TOOLS, CANONICAL_RUN_GRAPH_MCP_TOOLS, RUN_INSPECTION_TOOLS } from '@foreman-code/contracts/wave25'
import { currentWorkflowAvailable, currentWorkflowRequirements, type CurrentWorkflowOperation } from '../../../modules/workflows/currentWorkflowPolicy.js'
import { runInspectionToolAvailable, runInspectionRequirements } from './runInspection.js'
import { runGraphToolAvailable } from './runGraph.js'
import { ScheduleOperatorCapabilitiesSchema, workflowScheduleCapabilities } from './workflowSchedules.js'
import { jobCapabilities, JOB_QUEUE_CAPABILITY_DETAIL } from './jobs.js'
import { ciCapabilities } from '../../shared/ciTools.js'
import { jobRuntimeCapabilities } from './jobRuntimeProfiles.js'
import { hasAction, isAuthorized } from '../../../modules/access/policy.js'
import { invokeOperatorTool } from '../invoke.js'
import { OPERATOR_TOOL_ACTIONS } from '../catalog.js'
import { operatorToolAvailable,operatorToolRequirements } from '../availability.js'
import type { OperatorRequestContext } from '../types.js'
import { placementCapabilityLimit } from '../../../modules/placement/transports.js'
import type { OperatorCatalog } from '../presentation.js'

export const OPERATOR_RUNTIME_LIMITS = [
  { feature: 'native_tool_loading', state: 'protected',
    detail: 'agent_defaults_get/update reads and replaces role nativeTools policies with global settings grants. '
      + 'agent_create copies them; agent_update overrides them with scoped agents:update and revision checks. '
      + 'Read agent_get for the saved policy: mcpServers is a native server allowlist, apps controls apps/connectors '
      + 'and Claude SDK plugins, {} inherits host settings. Foreman Code retains its role and access grants. '
      + 'Changes apply to new sessions; accepted Runs keep immutable configuration pins. '
      + 'Claude external MCP connections remain unsupported.' },
  { feature: 'run_start_source', state: 'protected',
    detail: 'In a GitHub workspace, run_start fetches the configured default branch and automatically approves its '
      + 'tracked tree under the existing source policy and audit. All Run Agents retain that commit; unchanged '
      + 'commits reuse a snapshot. Requires workspace-scoped sources:approve, sources:read, source_roots:bind, '
      + 'source_roots:read and workspace_locations:read in addition to runs:start. Missing grants remain denied. '
      + 'ci_run without commit tests unchanged Agent files at that Run-start commit without uploading a bundle.' },
  { feature: 'run_start_contention', state: 'limited',
    detail: 'Concurrent run_start calls serialize on the command, runner and workspace locks. '
      + 'Each Start shares a 30-second deadline for those locks; RUN_START_BUSY means '
      + 'retry the same commandId and input. Ordinary SQL query deadlines and scoped Start grants still apply.' },
  {feature:'provider_accounts',state:'limited',detail:'Named account slots belong to one computer/application installation. Read/page/get/status/models require explicit provider_accounts:read; registration/rename/default/removal/auth prepare/cancel require provider_accounts:manage as well. Defaults apply only to new work without a saved account/profile. Accepted Runs and chats retain their original binding; removal preserves history. Authentication is reserved before native dispatch and reconciles the same operation after an unknown response. Only qualified native installations support authentication/models; browser authorization is human-only. MCP receives no credentials or challenges. Existing API-key provisioning remains local-human-only. Foreign installations are unavailable unless their owning Worker account service and advertised narrow transport are explicitly composed.'},
  { feature: 'agent_profile_placements', state: 'protected',
    detail: 'agent_update returns affectedWorkflowIds. Re-save each workflow with the returned configuration version IDs; '
      + 'workflow_validate_v3 and workflow_save_v3 reconcile explicit Agent node placements to harnessProfileSelection '
      + 'on the same computer, preserving source/root/CWD. A host mismatch returns a node-specific '
      + 'AGENT_PROFILE_PLACEMENT_CONFLICT issue. Historical WorkflowVersions and Runs retain their placements. '
      + 'Existing Agent, graph, harness and location grants still apply.' },
  { feature: 'operator_read_detail', state: 'limited', detail: 'source_list defaults to 10 compact source summaries and run_get to compact status with at most 25 executions and 25 activities. Both accept detail: "full". Compact reads omit file inventories and execution bodies; use source_get or paged Run inspection for more detail. workflow_save_v3 fills omitted graph.createdAt, graph.updatedAt and graph.version from the revision-checked workflow; revision, configuration and location pins remain required.' },
  { feature: 'workspace_repository_import', state: 'protected', detail: 'workspace_repository_add prepares a pinned supported tracked GitHub snapshot on Main in the existing app-managed Workspaces base, composing repository metadata, root location, source approval and binding. Read workspace_repository_get for readiness and incomplete progress. Discovery requires the complete scoped read/provision/update/approve/bind grant combination. Retry unknown acknowledgment with the original commandId and input; quarantined capture failures require a new import. Existing project folders, saved workflow versions and historical Runs remain retained.' },
  { feature: 'worker_updates', state: 'limited',
    detail: 'Paired Workers automatically match Main through the authenticated device connection. '
      + 'Updates wait for active work to drain, verify the artifact and install side-by-side; '
      + 'a failed release rolls back and reports the error. computers_maintenance_status requires global settings:read '
      + 'and exposes current/target versions, update state and last error. It defaults to compact task summaries '
      + '(newest 5 tasks, newest first), without outputTail. taskLimit accepts 1-50; running and queued tasks are always '
      + 'included and tasksOmitted counts excluded retained tasks per computer. Use detail: "full" for output '
      + 'with the same limit, optionally filtered by taskId. computers_maintenance_start with update-worker '
      + 'requires global settings:update; omitted targets select paired Workers only. Reuse the original commandId '
      + 'and input to recover the saved task, or a new commandId to retry. Older Workers without worker-update-v1 '
      + 'need one human installation of an updater-enabled Worker first. Main is updated with production:install.' },
  {feature:'source_approval',state:'protected',detail:'source_approve accepts either every tracked file in approvedPaths or approveTrackedTree: true with approvedPaths omitted. Both approve only the pinned commit tree, retain sensitive-path/content rejection, executable policy and source limits, and persist the approval choice and exact inventory. Requires sources:approve, sources:read and workspace_locations:read in the workspace.'},
  { feature: 'workflow_create_initial_save', state: 'protected',
    detail: 'workflow_create accepts initialSave {graph, expectedAgentConfigurationVersionIds, expectedLocationRevision}. '
      + 'Creation supplies workflow identity, name, description, defaultWorktree and timestamps. '
      + 'Create, validation, immutable save, receipts and audits commit together; failure leaves no workflow. '
      + 'Omitting initialSave still creates an unsaved workflow with workflows:create alone. '
      + 'initialSave additionally requires workflows:read/update, graph:read/edit/save, agents:read and workspace_locations:read '
      + 'in the workspace without workflow-ID restrictions, plus referenced skill/harness/source grants. '
      + 'Retry the same commandId and input; changed input conflicts. Read the saved version with workflow_saved_get_v3.' },
  {feature:'current_workflow_semantics',state:'limited',detail:'One semantics-3 authoring/read/Start contract covers ordinary, parallel/all-required, conditional/approval and optional bounded repeat. Ordinary definitions omit repeat. Read workflow_authoring_capabilities_v3 for separately composed native Start/Stop readiness. Stage/Discard do not execute; Stop-and-save waits for exact settlement.'},
  {feature:'general_questions_and_forms',state:'limited',detail:'Codex supports typed questions, offered choices, free-text answers and schema-validated MCP forms through operator_chat_respond or agent_chat_respond. Responses require the original owned native session/callback and the chat respond grant; read access does not grant response authority. User answers must be supplied explicitly. Other providers and arbitrary untyped forms are not implied; read harness_get interactionSupport for provider-specific support.'},
  {feature:'agent_interval_checks',state:'limited',detail:'Agent node.interval {everySeconds} (off by default; range in workflow_authoring_capabilities_v3 agentInterval) re-activates that Agent with a check prompt while its Run is active, after its first finished execution. Checks continue the node session when the node keeps its working directory (a placed node gets a fresh checkout), never route the graph, use the execution budget or consume maxParallelism slots, serialize with work on the same node, stop with the Run (at most agentInterval.maximumChecksPerRun per Run), and give that node a read-only, Run-scoped run_status_get tool. They need approval handler native or a Codex Agent with approvalPolicy never and are rejected inside repeat blocks and on Agents with artifactOutputs. Save with workflow_save_v3 or workflow_edit_v3; read back with workflow_saved_get_v3.'},
  {feature:'named_workflow_routing',state:'limited',detail:'Explicit named outcomes, acyclic execution relationships and all-required joins share the current validator. Arbitrary cycles, nested repeats, inferred routes and unknown outcomes are rejected. Valid authoring is not native admission.'},
  {feature:'run_pause_node_retry_and_steering',state:'unsupported',detail:'Pause, selected-node retry, single-execution Stop, and live worker steering are not implemented. A deliberate new full Run uses the current pinned run_start contract; the old unpinned retry adapter is retired.'},
  {feature:'checkpoint_resume',state:'limited',detail:'Automatic current checkpoint continuation requires A’s exact native approval receipts. The old manual run_resume adapter is retired; no caller can skip approval.'},
  {feature:'process_exit_confirmation',state:'limited',detail:'run_stop recovers interrupted native lifetimes only with positive closure evidence under the Run owner fence. Live or unconfirmed owners stay pending; domain errors permit retry with the same commandId and input. Run Stop also cancels its Agents’ non-terminal CI tickets and their provider runs, with audit; CI failures retain pending cleanup for retry. This subordinate cleanup requires runs:stop, without an additional jobs:cancel grant. Stop acceptance is not native-process-exit proof; processStopped remains conservative.'},
  {feature:'historical_runs',state:'limited',detail:'Restore history into a new validated current version before running it. Old immutable versions are never edited.'},
  {feature:'resource_deletion',state:'protected',detail:'Workspace archive retains workflow/run history and deletes app-created project folders. Archive cleanup protects accepted Run directories and pending cleanup even after workspace location changes. workspace_storage_folder_delete explicitly deletes an unregistered direct-child folder and its contents using its listed identity and global archive/provision/location-read grants. Registered locations, defaults, active runs, roots and symlinks are protected.'},
  {feature:'remote_runners_and_host_browsing',state:'limited',detail:'workspace_create folder provisioning operates on the local runner under an explicit parentPath with provisioning, location-update and location-read grants. workspace_folders_list and workspace_folder_create operate only inside app-managed workspace storage; Desktop and runtime storage are not workspace destinations. There is no arbitrary host browsing. Execution on an approved computer requires its separately configured services and accepted source/root authority.'},
  {feature:'approval_reassignment',state:'protected',detail:'Read permissions span handlers; response authority stays with the accepted handler. Changing a draft does not take over a running request.'},
  {feature:'trusted_device_owner_approval',state:'protected',detail:'Operator can discover, inspect, check and read trusted device connections, and configure consent using an existing exact browser owner approval. Requesting, approving and revoking that human approval requires the local human in the browser; settings:update never permits self-approval or grants agent execution permissions.'},
  {feature:'operator_self_authorization',state:'protected',detail:'No tools are added for the Operator to answer its own human gates or manage its delegated credential.'},
  {feature:'native_mcp_provisioning',state:'protected',detail:'Native MCP connections can be listed and changes requested, including installation, removal, disabling, and enabling of the exact Foreman Code (one connection for every role) and read-only Linear presets. A local human applies changes in Harness Settings, including one-click preset actions. The Operator cannot approve its own request, expose credentials, or approve package installation. Connection requests do not download packages.'},
  {feature:'fleet_mcp_sync',state:'limited',detail:'computers_maintenance_start sync-mcp requires settings:update and maintenance protocol 2, and uses the same sync service as Settings. Reuse the original commandId and input after an unknown response; Main retains the selected targets/catalogs and receivers retain command outcomes across restarts. Unsafe definitions, disabled servers, native tool allow/deny lists and stdio environment-name references are skipped and reported. Intentional credential skips do not fail a task. Automatic sync retries failed tasks after 5 minutes with exponential backoff capped at one hour; a manual start with a new commandId retries immediately. Existing Worker entries for skipped definitions are preserved; only fleet-managed entries deleted from an available Main catalog are removed. Missing harnesses leave nonempty MCP sync pending. Configure unsupported settings separately on each computer. Read persisted task outcomes with computers_maintenance_status using settings:read.'},
  {feature:'claude_configuration',state:'limited',detail:'Claude supports only the explicitly pinned app HTTP MCP connection; external MCP servers are rejected because their tool manifests are not supported. claude_setup_options_get reads this API’s Foreman Code endpoint; harness_defaults_update and harness_instance_save persist configuration with their existing grants and revisions. Saving does not qualify Claude, grant tools or change native login/configuration files. Claude accepts only Full access; saving or starting Read only or Workspace write configuration returns a validation error. Detected defaults remain incomplete until Full access is explicitly selected. harness_instance_check rejects a profile directory that differs from the host process CLAUDE_CONFIG_DIR before any paid turn, then runs explicit local subscription qualification with Write and app tool-policy checks. Execution requires the checked host, configuration, sandbox and native lifecycle.'},
  {feature:'codex_plugins',state:'protected',detail:'Installed and available Codex plugins and verified bundle contents can be read through Operator MCP. Installing or removing a plugin is human-only in Codex Harness Settings because plugins can add executable hooks, skills, and external MCP access; Operator cannot request or approve plugin writes.'},
  {feature:'harness_installation_updates',state:'limited',detail:'Main and Workers refresh installed harness inventory and automatically requalify previously qualified enabled profiles after payload changes. Startup inspection timeouts keep Main profile checks pending and retry automatically. Automatic qualification retries invalid version output up to three times with backoff only for an unchanged previously qualified binary; exhaustion persists a failure. Compatibility retries do not qualify execution. harness_instances_list requires harnesses:read and reports qualifying or a persisted qualificationFailure. New Run starts return HARNESS_PROFILE_CHECK_PENDING while checks run; retry the same Start command once qualified. Running native processes retain their original installation and qualification under their existing owner checks. Explicit checks still require harnesses:read and harnesses:update; automatic checks do not change grants, sandbox policy or saved WorkflowVersion and Run facts.'},
  {feature:'schedule_delivery',state:'unsupported',detail:'Retired unpinned trigger admission is not active. This current delivery exposes only explicit pinned manual run_start; no scheduled or event Start is promised.'},
  {feature:'skills',state:'limited',detail:'Skills are workspace-owned Markdown instruction text managed with skill_list/get/versions_list/create/update/archive. Every save creates an immutable version; Agents pin exact versions through agent_create/agent_update or the board and never follow later edits. Skill text is delivered as native Agent instructions, never as tool grants. Packages, folders, scripts, URLs and includes are not supported. Persistent instructions plus skills are limited to 512 KiB per Agent.'},
] as const

export function registerContextTools(server: McpServer, context: OperatorRequestContext, catalog?: OperatorCatalog): void {
  if (!operatorToolAvailable(context,'operator_get_capabilities')) return
  server.registerTool('operator_get_capabilities', {
    description: 'Inspect your grants, compatible tool permissions, optional resource scope, and explicit runtime limits. Supply a complete workspace/workflow/run hierarchy for resource checks. Defaults to compact; detail:full returns all requirements and runtime instructions. This is not a grant or a promise that a specific object exists.',
    inputSchema: OperatorCapabilityInputSchema,
    outputSchema: ScheduleOperatorCapabilitiesSchema.or(OperatorCompactCapabilitiesSchema),
    annotations: {readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  }, async (input, callbackContext) => invokeOperatorTool(context, 'operator_get_capabilities', async () => {
    const capabilities = operatorCapabilities(context, input)
    if (input.detail === 'full') return capabilities
    const { requirements: _requirements, ...compact } = capabilities
    void _requirements
    const tools = await catalog?.(callbackContext)
    const selectedResource = input.workspaceId || input.workflowId || input.runId
    const names = tools?.map((tool) => tool.name) ?? capabilities.tools
    const scopedNames = new Set<string>(capabilities.tools)
    if (selectedResource) {
      for (const name of Object.values(RUN_HISTORY_TOOLS)) {
        if (runHistoryToolAvailable(context, name, capabilities.requestedResource)) scopedNames.add(name)
      }
      for (const name of FILE_REFERENCE_TOOL_NAMES) {
        if (fileReferenceToolAvailable(context, name, capabilities.requestedResource)) scopedNames.add(name)
      }
      for (const name of FILE_RETENTION_TOOL_NAMES) {
        if (fileRetentionToolAvailable(context, name)) scopedNames.add(name)
      }
    }
    return { ...compact, detail: 'compact' as const,
      tools: selectedResource ? names.filter((name) => scopedNames.has(name)) : names,
      detailsTool: 'operator_tool_schema_get' as const, fullDetailArguments: { detail: 'full' as const },
      runtimeLimits: capabilities.runtimeLimits.map((entry) => ({ ...entry,
        detail: compactRuntimeDetails[entry.feature] ?? entry.detail,
      })),
    }
  }))
}

export function operatorCapabilities(context: OperatorRequestContext, input: {
  workspaceId?: string | undefined; workflowId?: string | undefined; runId?: string | undefined;
}) {
    const resource={...(input.workspaceId?{workspaceId:input.workspaceId}:{}),...(input.workflowId?{workflowId:input.workflowId}:{}),...(input.runId?{runId:input.runId}:{})}
    const ordinary=OPERATOR_TOOL_ACTIONS.filter((entry)=>operatorToolAvailable(context,entry.name,resource)).map((entry)=>entry.name)
    const current = (Object.keys(CURRENT_WORKFLOW_TOOLS) as CurrentWorkflowOperation[]).filter((operation) =>
      !!context.services.workflows?.current && currentWorkflowAvailable(context.principal, operation, resource))
    const graph = context.services.runGraph && (Object.keys(resource).length
      ? isAuthorized(context.principal, 'runs:read', resource) : hasAction(context.principal, 'runs:read'))
      ? Object.values(CANONICAL_RUN_GRAPH_MCP_TOOLS).filter((name) => runGraphToolAvailable(context, name)) : []
    const inspection = Object.values(RUN_INSPECTION_TOOLS).filter((name) => runInspectionToolAvailable(context, name, resource))
    const schedules = workflowScheduleCapabilities(context, resource)
    const jobs = jobCapabilities(context, resource)
    const ci = ciCapabilities(context, resource)
    const jobRuntime = jobRuntimeCapabilities(context, resource)
    const scheduleRuntime = context.services.runs?.scheduleAvailability?.()
    const runtimeLimits = OPERATOR_RUNTIME_LIMITS.map((limit) =>
      limit.feature === 'schedule_delivery' && scheduleRuntime?.configured
        ? { feature: limit.feature, state: 'limited' as const,
          detail: 'The API dispatcher uses the same pinned Start and engine as manual Runs. It admits only the latest due occurrence within five minutes, skips overlapping scheduled Runs, and pins the latest saved workflow. Live owner grants and native runtime readiness are rechecked. Retired unpinned triggers and event Start remain unavailable. '
            + (scheduleRuntime.runtimeAdmission ? 'Timed Run admission is available.'
              : 'Timed Run admission is paused until native runtime readiness returns.') }
        : limit)
    const tools = [...ordinary, ...current.map((operation) => CURRENT_WORKFLOW_TOOLS[operation]), ...graph, ...inspection, ...schedules.map((entry) => entry.name), ...jobs.map((entry) => entry.name), ...ci.map((entry) => entry.name), ...jobRuntime.map((entry) => entry.name)]
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
          detail: 'Private bounded V3 Run inspection. runs:read is checked on the exact persisted Run; run_version_get additionally requires workflows:read on its workflow. Read-only grants are sufficient; no execution authority is conferred.' })), ...schedules, ...jobs, ...ci, ...jobRuntime],
      runtimeLimits:[...runtimeLimits, runHistoryCapabilityLimit(context),
        placementCapabilityLimit(Boolean(context.services.runPlacements && context.services.placementChoices)),
        ...(jobs.length ? [{ feature: 'ci_jobs', state: 'limited' as const,
        detail: JOB_QUEUE_CAPABILITY_DETAIL + ' Only listed operations are available to this caller. '
          + 'Launch requires an approved source/root and current host-bound CI qualification. '
          + 'Connecting a computer or listing tools is not qualification. '
          + 'Job management tools remain Operator-only; Agents use the CI tools to choose computers, run, poll, read logs/artifacts and cancel in their Run workspace. '
          + 'Revoked-Worker cleanup requires separate local-human approval; MCP cannot approve itself or enable execution.'
      }] : []), ...(schedules.length ? [{ feature: 'schedule_persistence', state: 'limited' as const,
        detail: 'Schedule CRUD and bounded occurrence history have HTTP/MCP parity. '
          + (scheduleRuntime?.configured ? 'Timed Run admission is composed; see schedule_delivery for policy and readiness. '
            : 'This persistence-only composition has no dispatcher or timed Run admission. ')
          + 'Clear/paging/discovery compositions await shared-contract follow-up.' }] : []), ...(context.services.fileReferences ? [{
        feature: 'permanent_reference_files', state: 'limited' as const,
        detail: 'Permanent references support reference_files_list, reference_file_read, reference_file_add and reference_file_remove through tools/list. Read requires the scope-specific workspaces:read or workflows:read grant; add/remove additionally require the matching update grant. Worker access is not granted. These backend extension names are not in this frozen capability tools enum; use tools/list for caller-filtered schemas. Agent access resolution is separate.',
      }] : [])],
      workerToolsMcp:{implemented:context.services.workerToolsMcpImplemented===true,endpoint:'/mcp'}}
}

const compactRuntimeDetails: Record<string, string> = {
  worker_updates: 'Workers drain, verify and match Main automatically; failures roll back. Read status with settings:read; '
    + 'trigger/retry update-worker with settings:update. Older Workers need an initial updater-enabled installation. '
    + 'Main uses production:install.',
  current_workflow_semantics: 'Semantics 3; optional finite repeat. Read workflow_authoring_capabilities_v3 for native readiness.',
  general_questions_and_forms: 'Codex typed questions and MCP forms use chat respond tools with the original session/callback and respond grant. Explicit user input required; see harness_get interactionSupport for provider limits.',
  agent_interval_checks: 'Agent node.interval re-activates an Agent while its Run is active; off by default, never routes or consumes maxParallelism slots, serializes with same-node work, gives run_status_get.',
  named_workflow_routing: 'Named acyclic routes and all-required joins; no nested repeat or arbitrary cycles.',
  run_pause_node_retry_and_steering: 'No pause, node retry, per-execution Stop or live steering.',
  checkpoint_resume: 'Automatic continuation requires accepted native approvals; no manual bypass.',
  process_exit_confirmation: 'Stop acceptance does not confirm native process exit.',
  historical_runs: 'Restore history into a new validated version before running; historical versions stay immutable.',
  run_board_history: 'Run history needs composed services and live runs:read. Run-only grants read their Runs; legacy Runs may lack snapshots.',
  resource_deletion: 'Archive retains history. Folder deletion protects registered locations, active runs, defaults and links.',
  remote_runners_and_host_browsing: 'Explicit local workspace provisioning or approved computers only; no arbitrary host browsing.',
  approval_reassignment: 'Only the accepted handler can respond to a running approval.',
  trusted_device_owner_approval: 'Consent requires browser owner approval. Request, approval and revocation are human-only.',
  operator_self_authorization: 'Operator cannot approve its own gates or manage its delegated credential.',
  native_mcp_provisioning: 'Operator requests changes; a local human applies them in Harness Settings.',
  claude_configuration: 'Pinned app MCP only; Full access required. Saving is not qualification; host-bound checking is required.',
  codex_plugins: 'Plugin reads are supported; installation and removal are human-only in Harness Settings.',
  skills: 'Workspace Markdown skills pin immutable versions; 512 KiB instructions limit. No packages/scripts/URLs or tool grants.',
  ci_jobs: 'Approved source/root and host CI qualification required. Revoked-Worker cleanup requires local-human approval.',
  permanent_reference_files: 'Scope read grants required; add/remove also need matching update grants. Operator-only.',
}
