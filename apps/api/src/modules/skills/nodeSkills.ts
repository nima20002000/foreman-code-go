import type { GraphSqlClient } from '../run-graph/connection.js'
import type { AgentConfigurationVersion } from '@foreman-code/contracts'
import type { NodeSkillOverride } from '@foreman-code/contracts/wave25'
import { resolveAssignedSkills } from './catalog.js'

/** One workflow node's skills: the Agent's assigned skills minus the removed ones, then the added exact
 * versions, resolved into the instruction snapshot of that execution. The pinned Agent version is unchanged. */
export async function configurationWithNodeSkills(client: GraphSqlClient, configuration: AgentConfigurationVersion,
  override: NodeSkillOverride): Promise<AgentConfigurationVersion> {
  const removed = new Set(override.remove ?? [])
  const references = [...configuration.assignedSkills.filter(skill => !removed.has(skill.skillId)), ...override.add ?? []]
  const resolvedSkills = await resolveAssignedSkills(client, configuration.workspaceId, references, configuration.assignedSkills)
  return { ...configuration, assignedSkills: references, resolvedSkills }
}
