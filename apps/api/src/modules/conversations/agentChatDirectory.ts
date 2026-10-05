import { posix } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type pg from 'pg'
import type { AgentConfigurationVersion, ExecutionLocation } from '@foreman-code/contracts'
import { AgentChatDirectoryBindingSchema, type AgentChatDirectoryBinding } from '@foreman-code/contracts/agent-chat'
import { SavedNodePlacementSchema, type SavedNodePlacement } from '@foreman-code/contracts/node-placement'
import { ApprovedRootAllowlistSchema, WorkspaceRootPolicySchema } from '@foreman-code/contracts/workspace-root-policies'
import { requiredLocationAccess } from '../workspaces/location.js'
import { DomainError } from '../errors.js'
import { workspaceRootHostScope } from '../sources/rootPolicies.js'

function unavailable(message: string): never { throw new DomainError('AGENT_CHAT_DIRECTORY_UNAVAILABLE', message, 409) }

/** Called inside Agent-chat admission; reading the saved directory does not grant source-management access. */
export async function resolveAgentChatDirectory(input: {
  sql: Pick<pg.Pool, 'query'>
  configuration: AgentConfigurationVersion
  workflowVersionId: string
  placement?: SavedNodePlacement
  location?: ExecutionLocation
}): Promise<{ workingDirectory: string; directoryBinding?: AgentChatDirectoryBinding }> {
  const selector = input.configuration.harnessProfileSelection
  if (!input.placement) {
    if (!input.location) unavailable('Set a workspace folder before chatting with this Agent.')
    const host = selector?.target.hostRef
    const expectedRunner = host?.kind === 'device' ? `device:${host.deviceId}` : 'runner-local'
    if (input.location.runnerId !== expectedRunner) unavailable('The workspace folder belongs to another execution host.')
    return { workingDirectory: input.location.rootPath }
  }
  const placement = SavedNodePlacementSchema.parse(input.placement)
  if (!selector || !isDeepStrictEqual(selector.target.hostRef, placement.hostRef)
    || selector.instanceId !== placement.instanceId || selector.instanceRevision !== placement.instanceRevision
    || selector.target.harnessInstallationId !== placement.harnessInstallationId) {
    unavailable('The saved node placement differs from its Agent profile. Save matching settings before chatting.')
  }
  const relative = placement.relativeCwd
  if (relative.includes('\0') || relative.length > 1024 || posix.isAbsolute(relative)
    || relative !== '' && relative.split('/').some(part => ['.', '..', ''].includes(part))
    || placement.cwdPolicy === 'project-root' && relative !== ''
    || placement.cwdPolicy === 'project-subdirectory' && relative === '') unavailable('The saved node folder is invalid.')
  const row = (await input.sql.query<{ policy: unknown; configuration: unknown; revoked_at: Date | null }>(`
    select p.record as policy,c.record as configuration,p.revoked_at from workspace_root_policies p
    join workspace_root_host_configuration_heads h on h.host_scope=p.host_scope
    join workspace_root_host_configurations c on c.host_scope=h.host_scope and c.configuration_revision=h.configuration_revision
    where p.root_policy_id=$1 and p.root_policy_revision=$2 and p.workspace_id=$3 and p.host_scope=$4`,
  [placement.rootPolicyId, placement.rootPolicyRevision, input.configuration.workspaceId,
    workspaceRootHostScope(placement.hostRef)])).rows[0]
  if (!row || row.revoked_at) unavailable('The saved node root is missing or revoked.')
  const policy = WorkspaceRootPolicySchema.parse(row.policy)
  const approved = ApprovedRootAllowlistSchema.parse(row.configuration)
  if (policy.workspaceId !== input.configuration.workspaceId || !isDeepStrictEqual(policy.hostRef, placement.hostRef)
    || !isDeepStrictEqual(approved.hostRef, placement.hostRef)
    || policy.applicationInstallationId !== selector.target.applicationInstallationId
    || approved.applicationInstallationId !== policy.applicationInstallationId
    || policy.rootPolicyId !== placement.rootPolicyId || policy.rootPolicyRevision !== placement.rootPolicyRevision
    || policy.locationRevision !== placement.locationRevision || policy.canonicalProjectRoot !== placement.projectRoot
    || policy.configurationRevision !== approved.configurationRevision
    || !approved.bases.some(base => base.baseId === policy.allowedBaseId && base.accessModes.includes(policy.accessMode))
    || requiredLocationAccess([input.configuration]) === 'read-write' && policy.accessMode !== 'read-write') {
    unavailable('The saved node root no longer matches its approved host settings.')
  }
  return { workingDirectory: posix.join(policy.canonicalProjectRoot, relative),
    directoryBinding: AgentChatDirectoryBindingSchema.parse({ workflowVersionId: input.workflowVersionId, placement, policy }) }
}

export async function revalidateAgentChatDirectory(sql: Pick<pg.Pool, 'query'>,
  configuration: AgentConfigurationVersion, raw: AgentChatDirectoryBinding, workingDirectory: string) {
  const binding = AgentChatDirectoryBindingSchema.parse(raw)
  const current = await resolveAgentChatDirectory({ sql, configuration,
    workflowVersionId: binding.workflowVersionId, placement: binding.placement })
  if (current.workingDirectory !== workingDirectory || !isDeepStrictEqual(current.directoryBinding, binding)) {
    unavailable('The conversation’s saved node directory changed.')
  }
}
