import { isDeepStrictEqual } from 'node:util'
import type pg from 'pg'
import { AgentConfigurationVersionSchema } from '@foreman-code/contracts'
import { WorkflowVersionV3Schema } from '@foreman-code/contracts/wave25'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { WorkerConversationBinding, WorkerConversationConfiguration } from '@foreman-code/contracts/remote-execution-rpc'
import { configurationWithNodeSkills } from '../skills/nodeSkills.js'
import { verifiedSkills } from '../skills/instructions.js'
import { DomainError } from '../errors.js'

export function sameRunChatBinding(previous: WorkerConversationBinding, next: WorkerConversationBinding) {
  return previous.owner.kind === 'agent' && next.owner.kind === 'agent'
    && previous.owner.configurationHash !== next.owner.configurationHash
    && isDeepStrictEqual({ ...previous, owner: { ...previous.owner,
      configurationHash: next.owner.configurationHash } }, next)
}

export function validRunChatSkillsTransition(previous: WorkerConversationBinding, next: WorkerConversationBinding,
  base: WorkerConversationConfiguration, effective: WorkerConversationConfiguration) {
  if (previous.owner.kind !== 'agent' || !sameRunChatBinding(previous, next) || !('agentId' in base) || !('agentId' in effective)
    || base.id !== previous.owner.configurationVersionId || base.agentId !== previous.owner.agentId
    || base.workspaceId !== previous.owner.workspaceId
    || commandInputHash(base) !== previous.owner.configurationHash
    || commandInputHash(effective) !== next.owner.configurationHash
    || !isDeepStrictEqual({ ...base, assignedSkills: effective.assignedSkills,
      resolvedSkills: effective.resolvedSkills }, effective)) return false
  verifiedSkills(base)
  verifiedSkills(effective)
  return true
}

export async function readRunChatSkillsTransition(pool: pg.Pool, original: {
  native_session_id: string | null; workspace_id: string | null; workflow_id: string | null
  workflow_node_id: string | null; record: { origin?: { kind: string; runId?: string } }
}, previous: WorkerConversationBinding, next: WorkerConversationBinding, configuration: WorkerConversationConfiguration) {
  if (!sameRunChatBinding(previous, next)) return undefined
  if (!original.native_session_id || original.record.origin?.kind !== 'run_execution'
    || !original.record.origin.runId) return undefined
  const found = (await pool.query<{ record: unknown; version: unknown }>(`select c.record,v.record as version
    from agent_configuration_versions c join runs r on r.id=$2 and r.workspace_id=c.workspace_id
    join workflow_versions v on v.id=r.workflow_version_id and v.workflow_id=$3
    where c.id=$1`, [previous.owner.configurationVersionId, original.record.origin.runId,
    original.workflow_id])).rows[0]
  const base = AgentConfigurationVersionSchema.parse(found?.record)
  const version = WorkflowVersionV3Schema.parse(found?.version)
  const node = version.definition.nodes.find(item => item.id === original.workflow_node_id)
  if (version.workspaceId !== original.workspace_id || version.workflowId !== original.workflow_id
    || !node || node.kind === 'job' || node.agentId !== base.agentId || !node.skills
    || version.agentConfigurationVersionIds[node.agentId] !== base.id) {
    throw new DomainError('WORKER_CONVERSATION_UNAVAILABLE', 'The saved Run chat node changed.', 409)
  }
  const effective = configurationWithNodeSkills(base, node.skills, version.nodeSkillSnapshots?.[node.id])
  if (!isDeepStrictEqual(configuration, effective) || !validRunChatSkillsTransition(previous, next, base, effective)) {
    throw new DomainError('WORKER_CONVERSATION_UNAVAILABLE', 'The saved Run chat skills changed.', 409)
  }
  return base
}
