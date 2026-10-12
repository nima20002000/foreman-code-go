import { type ManagementAction, type ManagementScope, type OperatorToolName } from '@foreman-code/contracts/management'
import { REPOSITORY_ADD_ACTIONS, REPOSITORY_READ_ACTIONS } from '../../modules/workspaces/repositoryService.js'
import { placementChoiceRequirements } from '../../modules/placement/choicesService.js'
import { hasAction, isAuthorized, type AuthorizedResource } from '../../modules/access/policy.js'
import { OPERATOR_TOOL_ACTIONS } from './catalog.js'
import { retiredExecutionTool } from './retiredExecutionTools.js'
import type { OperatorRequestContext } from './types.js'

type ScopeKind = 'global' | 'workspace' | 'workflow' | 'run' | 'resource' | 'caller'
type Requirement = {action: ManagementAction; scope: ScopeKind}
const extensions: Partial<Record<OperatorToolName,{scope:ScopeKind;extension:keyof NonNullable<OperatorRequestContext['services']['extensions']>}>> = {
  "harness_configuration_check": {
    "scope": "global",
    "extension": "native"
  },
  "harness_options_get": {
    "scope": "global",
    "extension": "native"
  },
  "harness_options_refresh": {
    "scope": "global",
    "extension": "native"
  },
  "harness_mcp_detection_get": {
    "scope": "workspace",
    "extension": "workspace"
  },
  "agent_create": {
    "scope": "workspace",
    "extension": "agents"
  },
  "agent_update": {
    "scope": "workspace",
    "extension": "agents"
  },
  "agent_clone": {
    "scope": "workspace",
    "extension": "agents"
  },
  "workflow_versions_list": {
    "scope": "workflow",
    "extension": "history"
  },
  "workflow_version_get": {
    "scope": "workflow",
    "extension": "history"
  },
  "agent_configuration_versions_list": {
    "scope": "resource",
    "extension": "history"
  },
  "agent_configuration_version_get": {
    "scope": "resource",
    "extension": "history"
  },
  "agent_configuration_restore": {
    "scope": "workspace",
    "extension": "agents"
  },
  "workspace_restore": {
    "scope": "workspace",
    "extension": "lifecycle"
  },
  "workflow_restore": {
    "scope": "workflow",
    "extension": "lifecycle"
  },
  "agent_archive": {
    "scope": "workspace",
    "extension": "lifecycle"
  },
  "agent_restore": {
    "scope": "workspace",
    "extension": "lifecycle"
  },
  "workspace_location_clear": {
    "scope": "workspace",
    "extension": "workspace"
  },
  "workspace_location_provision": {
    "scope": "workspace",
    "extension": "workspace"
  },
  "runner_list": {
    "scope": "workspace",
    "extension": "workspace"
  },
  "skill_list": {
    "scope": "workspace",
    "extension": "skills"
  },
  "skill_get": {
    "scope": "workspace",
    "extension": "skills"
  },
  "skill_versions_list": {
    "scope": "workspace",
    "extension": "skills"
  },
  "skill_create": {
    "scope": "workspace",
    "extension": "skills"
  },
  "skill_update": {
    "scope": "workspace",
    "extension": "skills"
  },
  "skill_archive": {
    "scope": "workspace",
    "extension": "skills"
  },
  "skill_usage_get": {
    "scope": "workspace",
    "extension": "skills"
  },
  "skill_users_update": {
    "scope": "workspace",
    "extension": "skills"
  },
}

export const TELEMETRY_READ_ACTIONS: readonly ManagementAction[] = ['devices:metrics:read', 'runs:read', 'jobs:read', 'agent_chat:read', 'operator_chat:read']

export function operatorToolRequirements(name: OperatorToolName, resource?: AuthorizedResource): Requirement[] {
  void resource
  if (name === 'workspace_repository_add' || name === 'workspace_repository_get') {
    const actions = name === 'workspace_repository_add' ? REPOSITORY_ADD_ACTIONS : REPOSITORY_READ_ACTIONS
    return actions.map(action => ({ action, scope: 'workspace' as const }))
  }
  if (name === 'workflow_node_placement_choices') return [...placementChoiceRequirements]
  if (name === 'resource_telemetry_read' || name === 'resource_telemetry_selector_get') return TELEMETRY_READ_ACTIONS.map(action => ({ action, scope: action === 'devices:metrics:read' ? 'global' : 'resource' }))
  const entry = OPERATOR_TOOL_ACTIONS.find((item) => item.name === name)!
  const extended = extensions[name]
  let scope: ScopeKind = extended?.scope ?? 'resource'
  if (name.startsWith('general_settings_') || name.startsWith('system_prompt_')
    || name.startsWith('remote_execution_settings_') || name.startsWith('operator_initial_prompt_')) scope = 'global'
  if (['harness_list','harness_get','harness_defaults_update','harness_qualifications_list','harness_qualification_run','harness_compatibility_list','harness_compatibility_retry','agent_defaults_get','agent_defaults_update','workflow_defaults_get','workflow_defaults_update','workspace_defaults_get','workspace_defaults_update','workspace_create','operator_chat_create','operator_chat_get','operator_chat_send','operator_chat_cancel','operator_chat_respond','operator_handoff_history_get'].includes(name)) scope = 'global'
  if (['operator_chat_list', 'operator_chat_history_get', 'operator_chat_activity_get',
    'operator_chat_delete', 'operator_chat_restore'].includes(name)) scope = 'global'
  if (['workflow_create','workspace_get','workspace_update','workspace_archive','workspace_location_validate','workspace_location_set','agent_get'].includes(name)) scope = 'workspace'
  if (name === 'execution_readiness_get' || name === 'harness_registry_get') scope = 'global'
  if (name === 'computer_activity_list' || name === 'computer_accounts_list' || name.startsWith('computers_maintenance_') || name.startsWith('computer_github_') || name === 'worker_execution_settings_get' || name.startsWith('build_computer')) scope = 'global'
  if (name.startsWith('workspace_root_')) scope = 'workspace'
  if (name.startsWith('source_')) scope = 'workspace'
  if (name.startsWith('device_connection_')) scope = 'global'
  if (['device_main_identity_get', 'devices_list', 'device_pairing_grant_create', 'device_revoke', 'device_setup_code_create', 'device_setup_options_get'].includes(name)) scope = 'global'
  if (name === 'run_start') scope = 'workflow'
  if (name === 'run_node_placement_get') scope = 'run'
  if (name.startsWith('agent_chat_')) scope = 'resource'
  if (name.startsWith('operator_chat_controls_')) scope = 'global'
  if (name === 'operator_get_capabilities' || name === 'operator_tool_schema_get') scope = 'caller'
  if (['claude_setup_options_get', 'operator_mcp_setup_get', 'harness_mcp_servers_list', 'harness_mcp_change_request', 'harness_mcp_managed_request', 'harness_mcp_change_get', 'harness_mcp_change_reconcile', 'codex_plugins_list', 'codex_plugin_get', 'codex_plugin_change', 'codex_plugin_reconcile', 'claude_plugins_list', 'claude_plugin_change', 'claude_plugin_marketplace_add'].includes(name)) scope = 'global'
  if (['workspace_folders_list', 'workspace_folder_create', 'workspace_folder_rename', 'workspace_folder_undo', 'workspace_folders_delete'].includes(name)) scope = 'global'
  const result: Requirement[] = [{action:entry.action,scope}]
  if (name.startsWith('provider_account')) {
    result[0]!.scope = 'global'
    if (entry.action === 'provider_accounts:manage') result.push({ action: 'provider_accounts:read', scope: 'global' })
  }
  if (name === 'interaction_respond') result.push({ action: 'interactions:read', scope: 'resource' })
  if (name === 'workspace_storage_folders_list' || name === 'workspace_storage_folder_delete') {
    result[0]!.scope = 'global'
    result.push({ action: 'workspace_locations:read', scope: 'global' })
    if (name === 'workspace_storage_folder_delete') result.push({ action: 'workspace_locations:provision', scope: 'global' })
  }
  if (name.startsWith('workspace_root_')) {
    if (entry.action !== 'source_roots:read') result.push({ action: 'source_roots:read', scope: 'workspace' })
    if (entry.action !== 'workspace_locations:read') result.push({ action: 'workspace_locations:read', scope: 'workspace' })
    if (name === 'workspace_root_location_set') result.push({ action: 'source_roots:bind', scope: 'workspace' }, { action: 'workspace_locations:validate', scope: 'workspace' })
  }
  if (name === 'source_approve') result.push({action:'sources:read',scope:'workspace'},{action:'workspace_locations:read',scope:'workspace'})
  if (name.startsWith('source_preparation_')) result.push({action:'source_roots:read',scope:'workspace'})
  if (name === 'source_preparation_reconcile') result.push({action:'sources:read',scope:'workspace'})
  if (name.startsWith('source_root_')) {
    result.push({action:'sources:read',scope:'workspace'})
    if (name !== 'source_root_bind') result.push({action:'workspace_locations:read',scope:'workspace'})
  }
  if (name === 'source_root_bind') result.push({action:'source_roots:read',scope:'workspace'},{action:'workspace_locations:read',scope:'workspace'})
  // Every chat command returns protected state. Discovery requires overlapping
  // read and command grants, including grants restricted to a selected Run.
  if (name.startsWith('agent_chat_') && name !== 'agent_chat_read') result.push({action:'agent_chat:read',scope:'resource'})
  if (['operator_chat_send', 'operator_chat_cancel', 'operator_chat_respond', 'operator_chat_controls_update'].includes(name)) result.push({action:'operator_chat:read',scope:'global'})
  if (name === 'skill_archive') result.push({action:'skills:read',scope:'workspace'})
  if (name === 'skill_users_update') result.push({action:'skills:read',scope:'workspace'})
  if (name === 'workspace_folders_list') result.push({action:'harnesses:read',scope:'global'})
  if (['workspace_folder_create', 'workspace_folder_rename', 'workspace_folder_undo', 'workspace_folders_delete'].includes(name)) result.push({action:'workspace_locations:read',scope:'global'})
  if (['harness_mcp_change_request', 'harness_mcp_managed_request', 'harness_mcp_change_reconcile', 'codex_plugin_change', 'codex_plugin_reconcile', 'claude_plugin_change', 'claude_plugin_marketplace_add'].includes(name)) result.push({action:'harnesses:read',scope:'global'})
  if (['run_start','harness_mcp_detection_get','workspace_location_provision','run_resume','run_retry'].includes(name)) result.push({action:'workspace_locations:read',scope:'workspace'})
  if (name === 'run_node_placement_get') result.push({action:'workspace_locations:read',scope:'workspace'})
  if (name === 'workspace_location_provision') result.push({action:'workspace_locations:update',scope:'workspace'})
  if (['agent_create','agent_update','agent_clone','agent_configuration_restore'].includes(name)) result.push({action:'agents:read',scope:name==='agent_clone'?'resource':'workspace'})
  if (['run_resume','run_retry'].includes(name)) result.push({action:'runs:read',scope:'run'})
  if (name.startsWith('run_subagent')) {
    result[0]!.scope = 'run'
    if (['run_subagent_input_v1', 'run_subagent_interrupt_v1', 'run_subagent_respond_v1'].includes(name)) {
      result.push({ action: 'runs:read', scope: 'run' })
    }
  }
  if (name === 'run_handoffs_get_v1') result.push({action:'workflows:read',scope:'workflow'})
  if (name === 'workflow_trigger_update') result.push({action:'workflows:read',scope:'workflow'})
  if (name === 'workflow_reorder') {
    result[0]!.scope = 'workflow'
    result.push({ action: 'workflows:read', scope: 'workflow' })
  }
  if (name === 'workflow_trigger_fire') result.push({action:'runs:start',scope:'workflow'},{action:'workspace_locations:read',scope:'workspace'})
  return result
}
function projected(resource: AuthorizedResource, kind: ScopeKind): AuthorizedResource {
  if (kind === 'global' || kind === 'caller') return {}
  if (kind === 'workspace') return resource.workspaceId ? {workspaceId:resource.workspaceId} : {}
  if (kind === 'workflow') return {...(resource.workspaceId?{workspaceId:resource.workspaceId}:{}),...(resource.workflowId?{workflowId:resource.workflowId}:{})}
  return resource
}
function usable(scope: ManagementScope, kind: ScopeKind): boolean {
  if (Object.values(scope).some((ids) => ids?.length === 0)) return false
  if (kind === 'global') return !scope.workspaceIds && !scope.workflowIds && !scope.runIds
  if (kind === 'workspace') return !scope.workflowIds && !scope.runIds
  if (kind === 'workflow') return !scope.runIds
  return true
}
function intersect(left: ManagementScope, right: ManagementScope): ManagementScope | undefined {
  const result: ManagementScope = {}
  for (const dimension of ['workspaceIds','workflowIds','runIds', 'mainIds', 'deviceIds',
    'applicationInstallationIds', 'providerAccountIds'] as const) {
    const a=left[dimension],b=right[dimension]
    const ids=a&&b ? a.filter((id)=>b.includes(id)) : a??b
    if (ids?.length===0) return undefined
    if (ids) result[dimension]=ids
  }
  return result
}
export function operatorToolAvailable(context: OperatorRequestContext, name: OperatorToolName, resource?: AuthorizedResource): boolean {
  if (retiredExecutionTool(name)) return false
  if (!OPERATOR_TOOL_ACTIONS.some((entry)=>entry.name===name)) return false
  const service = context.services
  if (name.startsWith('bug_report') && !service.bugReports) return false
  if (name.startsWith('provider_account') && !service.providerAccounts) return false
  if (name.startsWith('provider_account')) {
    const action = OPERATOR_TOOL_ACTIONS.find(entry => entry.name === name)!.action
    return hasAction(context.principal, 'provider_accounts:read')
      && (action === 'provider_accounts:read' || hasAction(context.principal, 'provider_accounts:manage'))
  }
  if ((name.startsWith('general_settings_') || name.startsWith('system_prompt_')
    || name.startsWith('operator_initial_prompt_')) && !service.settings) return false
  if (name === 'resource_telemetry_read' || name === 'resource_telemetry_selector_get') {
    if (!service.resourceTelemetry) return false
    return TELEMETRY_READ_ACTIONS.some(action => action === 'devices:metrics:read'
      ? isAuthorized(context.principal, action, {})
      : resource && Object.keys(resource).length ? isAuthorized(context.principal, action, resource) : hasAction(context.principal, action))
  }
  if (name === 'harness_registry_get' && !service.harnessRegistry) return false
  if (name.startsWith('workspace_repository_') && !service.workspaceRepositories) return false
  if (name.startsWith('workspace_root_') && !service.workspaceRoots) return false
  if (name.startsWith('source_') && !service.sources) return false
  if (name.startsWith('device_connection_') && !service.trustedConnections) return false
  if (['device_main_identity_get', 'devices_list', 'device_pairing_grant_create', 'device_revoke', 'device_setup_code_create', 'device_setup_options_get'].includes(name) && !service.devices) return false
  if (name.startsWith('run_') && !service.runs) return false
  if (name === 'run_node_placement_get' && !service.runPlacements) return false
  if (name === 'workflow_node_placement_choices' && !service.placementChoices) return false
  if (name.startsWith('run_subagent') && !service.runs?.subagents) return false
  if (name.startsWith('workflow_') && !service.workflows) return false
  if (name === 'execution_readiness_get' && !service.executionReadiness) return false
  if (name.startsWith('harness_compatibility_') && !service.harnessCompatibility) return false
  if ((name === 'harness_qualifications_list' || name === 'harness_qualification_run') && !service.harnessQualifications) return false
  if (name.startsWith('agent_chat_') && !service.agentChat) return false
  if ((name === 'operator_mcp_setup_get' || name.startsWith('operator_chat_') || name === 'operator_handoff_history_get')
    && !service.operatorChat) return false
  if (['workspace_folders_list', 'workspace_folder_create', 'workspace_folder_rename', 'workspace_folder_undo', 'workspace_folders_delete'].includes(name) && !service.harnessSettings) return false
  if (['workspace_storage_folders_list', 'workspace_storage_folder_delete'].includes(name) && !service.workspaces?.storageFolders) return false
  if (['harness_mcp_servers_list', 'harness_mcp_change_request', 'harness_mcp_managed_request', 'harness_mcp_change_get', 'harness_mcp_change_reconcile'].includes(name) && !service.harnessSettings) return false
  if (['codex_plugins_list', 'codex_plugin_get', 'codex_plugin_change', 'codex_plugin_reconcile'].includes(name) && !service.harnessSettings?.plugins) return false
  if (['claude_plugins_list', 'claude_plugin_change', 'claude_plugin_marketplace_add'].includes(name) && !service.harnessSettings?.claudePlugins) return false
  if (name.startsWith('interaction_') && !service.interactions) return false
  if (name === 'computer_activity_list' && !service.computerActivity) return false
  if (name === 'computer_accounts_list' && !service.computerAccounts) return false
  if (name.startsWith('computers_maintenance_') && !service.computerMaintenance) return false
  if (name.startsWith('computer_github_') && !service.computerGitHub) return false
  if (name.startsWith('build_computer') && !service.buildComputers) return false
  if (name === 'worker_execution_settings_get' && !service.workerExecution) return false
  if (name.startsWith('remote_execution_settings_') && !service.remoteExecution) return false
  if (['agent_defaults_get','agent_defaults_update','workflow_defaults_get','workflow_defaults_update','workspace_defaults_get','workspace_defaults_update'].includes(name) && !service.settings) return false
  const extended = extensions[name]
  if (extended && !service.extensions?.[extended.extension]) return false
  if (name==='workspace_location_provision' && !service.extensions?.workspace.provisioningEnabled) return false
  const requirements=operatorToolRequirements(name, resource)
  if (resource && Object.keys(resource).length) return requirements.every((requirement)=>
    requirement.scope==='caller' ? hasAction(context.principal,requirement.action)
      : isAuthorized(context.principal,requirement.action,projected(resource,requirement.scope)))
  // Require compatible grant scopes, not an action on one workspace plus a
  // dependent permission on a disjoint workspace. Bound branching for a large
  // grant set by returning a conservative unavailable result, never broadening.
  let scopes: ManagementScope[]=[{}]
  for(const requirement of requirements) {
    if (!hasAction(context.principal,requirement.action)) return false
    if (requirement.scope==='caller') continue
    const grants=context.principal.grants.filter((grant)=>grant.actions.includes(requirement.action)&&usable(grant.scope,requirement.scope))
    const next:ManagementScope[]=[]
    for(const scope of scopes) for(const grant of grants) {
      const combined=intersect(scope,grant.scope)
      if (combined) next.push(combined)
      if (next.length>10_000) return false
    }
    if (!next.length) return false
    scopes=next
  }
  return true
}
