import { createHash } from 'node:crypto'
import type { AgentConfigurationVersion } from '@graphql/contracts'
import { HarnessExecutionError } from '../harnesses/errors.js'

/** Never resolve a mutable catalog from a running execution or silently drop missing content. */
export function resolvedSkillPrompt(configuration: AgentConfigurationVersion): string[] {
  const references = configuration.assignedSkills
  const snapshots = configuration.resolvedSkills ?? []
  if (!references.length && !snapshots.length) return []
  if (references.length !== snapshots.length || new Set(references.map((item) => item.skillId)).size !== references.length) {
    throw new HarnessExecutionError('SKILL_SNAPSHOT_MISSING', 'Republish the Agent configuration with validated skill versions before running it.')
  }
  const sections: string[] = []
  for (const [index, reference] of references.entries()) {
    const skill = snapshots[index]
    if (!skill || skill.skillId !== reference.skillId || skill.version !== reference.version
      || skill.contentHash !== `sha256:${createHash('sha256').update(skill.instructions, 'utf8').digest('hex')}`) {
      throw new HarnessExecutionError('SKILL_SNAPSHOT_INVALID', 'The accepted skill snapshot failed its identity/integrity check.')
    }
    sections.push(`ASSIGNED SKILL ${skill.skillId}@${skill.version}`, skill.instructions, '')
  }
  return sections
}
