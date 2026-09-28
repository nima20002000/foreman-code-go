import { type ManagementAction, type ManagementScope, type OperatorToolName } from '@graphql/contracts/management'
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
  "opencode_models_cache_update": {
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
}

export function operatorToolRequirements(name: OperatorToolName, resource?: AuthorizedResource): Requirement[] {
  void resource
  const entry = OPERATOR_TOOL_ACTIONS.find((item) => item.name === name)!
  const extended = extensions[name]
  let scope: ScopeKind = extended?.scope ?? 'resource'
  if (['harness_list','harness_get','harness_defaults_update','agent_defaults_get','agent_defaults_update','workflow_defaults_get','workflow_defaults_update','workspace_defaults_get','workspace_defaults_update','workspace_create','operator_chat_create','operator_chat_get','operator_chat_send','operator_handoff_history_get'].includes(name)) scope = 'global'
  if (['workflow_create','workspace_get','workspace_update','workspace_archive','workspace_location_validate','workspace_location_set','agent_get'].includes(name)) scope = 'workspace'
  if (name === 'execution_readiness_get') scope = 'global'
  if (name === 'run_start') scope = 'workflow'
  if (name.startsWith('agent_chat_')) scope = 'resource'
  if (name === 'operator_get_capabilities') scope = 'caller'
  if (['operator_mcp_setup_get', 'harness_mcp_servers_list', 'harness_mcp_change_request', 'harness_mcp_managed_request', 'harness_mcp_change_get', 'codex_plugins_list', 'codex_plugin_get'].includes(name)) scope = 'global'
  if (['workspace_folders_list', 'workspace_folder_create', 'workspace_folder_rename', 'workspace_folder_undo', 'workspace_folders_delete'].includes(name)) scope = 'global'
  const result: Requirement[] = [{action:entry.action,scope}]
  // Every chat command returns protected state. Discovery requires overlapping
  // read and command grants, including grants restricted to a selected Run.
  if (name.startsWith('agent_chat_') && name !== 'agent_chat_read') result.push({action:'agent_chat:read',scope:'resource'})
  if (name === 'skill_archive') result.push({action:'skills:read',scope:'workspace'})
  if (name === 'workspace_folders_list') result.push({action:'harnesses:read',scope:'global'})
  if (['workspace_folder_create', 'workspace_folder_rename', 'workspace_folder_undo', 'workspace_folders_delete'].includes(name)) result.push({action:'workspace_locations:read',scope:'global'})
  if (['harness_mcp_change_request', 'harness_mcp_managed_request'].includes(name)) result.push({action:'harnesses:read',scope:'global'})
  if (name === 'opencode_models_cache_update') result.push({action:'harnesses:read',scope:'global'})
  if (['run_start','harness_mcp_detection_get','workspace_location_provision','run_resume','run_retry'].includes(name)) result.push({action:'workspace_locations:read',scope:'workspace'})
  if (name === 'workspace_location_provision') result.push({action:'workspace_locations:update',scope:'workspace'})
  if (['agent_create','agent_update','agent_clone','agent_configuration_restore'].includes(name)) result.push({action:'agents:read',scope:name==='agent_clone'?'resource':'workspace'})
  if (['run_resume','run_retry'].includes(name)) result.push({action:'runs:read',scope:'run'})
  if (name === 'run_handoffs_get_v1') result.push({action:'workflows:read',scope:'workflow'})
  if (name === 'workflow_trigger_update') result.push({action:'workflows:read',scope:'workflow'})
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
  for (const dimension of ['workspaceIds','workflowIds','runIds'] as const) {
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
  if (name.startsWith('run_') && !service.runs) return false
  if (name.startsWith('workflow_') && !service.workflows) return false
  if (name === 'execution_readiness_get' && !service.executionReadiness) return false
  if (name.startsWith('agent_chat_') && !service.agentChat) return false
  if ((name === 'operator_mcp_setup_get' || name.startsWith('operator_chat_') || name === 'operator_handoff_history_get')
    && !service.operatorChat) return false
  if (['workspace_folders_list', 'workspace_folder_create', 'workspace_folder_rename', 'workspace_folder_undo', 'workspace_folders_delete'].includes(name) && !service.harnessSettings) return false
  if (['harness_mcp_servers_list', 'harness_mcp_change_request', 'harness_mcp_managed_request', 'harness_mcp_change_get'].includes(name) && !service.harnessSettings) return false
  if (['codex_plugins_list', 'codex_plugin_get'].includes(name) && !service.harnessSettings?.plugins) return false
  if (name.startsWith('interaction_') && !service.interactions) return false
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
