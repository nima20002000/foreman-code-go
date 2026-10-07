import type pg from 'pg'
import { AgentConfigurationVersionSchema, AgentSchema } from '@foreman-code/contracts'
import { SkillUsageSchema, SkillUsersUpdateResultSchema, type SkillUsage,
  type SkillUsersUpdateResult } from '@foreman-code/contracts/management'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { WorkflowDefinitionV3Schema, WorkflowVersionV3Schema } from '@foreman-code/contracts/wave25'
import { requireAuthorization } from '../access/policy.js'
import { DomainError } from '../errors.js'
import type { OperatorAgentMutationService } from '../workspaces/operatorAgents.js'
import type { CurrentWorkflowAuthoring } from '../workflows/currentAuthoring.js'

type Source = 'http' | 'mcp'
interface AgentRow { id: string; record: unknown; metadata_revision: string; configuration: unknown }

/** Finds Agents still on an older skill version and moves them, and the workflows that use them, to the current one. */
export class SkillUsageService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly agents: Pick<OperatorAgentMutationService, 'update'>,
    private readonly workflows: Pick<CurrentWorkflowAuthoring, 'save'>,
  ) {}

  async usage(principal: ManagementPrincipal, input: { workspaceId: string; skillId: string }): Promise<SkillUsage> {
    requireAuthorization(principal, 'skills:read', { workspaceId: input.workspaceId })
    const state = await this.read(input.workspaceId, input.skillId)
    return SkillUsageSchema.parse({ skillId: input.skillId, headVersion: state.head,
      agents: state.outdated.map(agent => ({ agentId: agent.id, name: agent.name, version: agent.version })),
      workflows: state.workflows.map(workflow => ({ workflowId: workflow.id, name: workflow.name })) })
  }

  async updateUsers(principal: ManagementPrincipal, source: Source,
    input: { workspaceId: string; skillId: string; commandId: string }): Promise<SkillUsersUpdateResult> {
    requireAuthorization(principal, 'skills:read', { workspaceId: input.workspaceId })
    // Each Agent and workflow save rechecks its own grants; a caller who cannot edit Agents is refused up front.
    requireAuthorization(principal, 'agents:update', { workspaceId: input.workspaceId })
    const before = await this.read(input.workspaceId, input.skillId)
    const result: SkillUsersUpdateResult = { headVersion: before.head, agents: [], workflows: [], failed: [] }
    for (const agent of before.outdated) {
      try {
        const updated = await this.agents.update(principal, { workspaceId: input.workspaceId, agentId: agent.id,
          commandId: `${input.commandId}:agent:${agent.id}`, expectedRevision: agent.revision,
          expectedConfigurationVersionId: agent.configurationVersionId,
          assignedSkills: agent.assignedSkills.map(skill => skill.skillId === input.skillId ? { ...skill, version: before.head } : skill) })
        result.agents.push({ agentId: agent.id, configurationVersionId: updated.value.agent.configurationVersionId! })
      } catch (error) { result.failed.push(failure('agent', agent.id, error)) }
    }
    // Saved workflows pin Agent versions; re-save each one that uses a changed Agent so its next Run uses it.
    const after = await this.read(input.workspaceId, input.skillId)
    for (const workflow of after.workflows) {
      try {
        const saved = await this.workflows.save(principal, source, { workspaceId: input.workspaceId, workflowId: workflow.id,
          executionSemanticsVersion: 3, commandId: `${input.commandId}:workflow:${workflow.id}`,
          expectedRevision: workflow.revision, expectedWorkflowVersionId: workflow.versionId,
          expectedAgentConfigurationVersionIds: workflow.currentPins, expectedLocationRevision: after.locationRevision,
          graph: workflow.graph }) as { value: { currentVersionId: string } }
        result.workflows.push({ workflowId: workflow.id, workflowVersionId: saved.value.currentVersionId })
      } catch (error) { result.failed.push(failure('workflow', workflow.id, error)) }
    }
    return SkillUsersUpdateResultSchema.parse(result)
  }

  private async read(workspaceId: string, skillId: string) {
    const client = await this.pool.connect()
    try {
      const head = (await client.query<{ head_version: string }>(
        'select head_version from workspace_skills where workspace_id=$1 and skill_id=$2', [workspaceId, skillId])).rows[0]?.head_version
      if (!head) throw new DomainError('SKILL_NOT_FOUND', 'The skill was not found in this workspace.', 404)
      const location = (await client.query<{ location_revision: string }>(
        'select location_revision from workspaces where id=$1', [workspaceId])).rows[0]
      if (!location) throw new DomainError('WORKSPACE_NOT_FOUND', 'The workspace was not found.', 404)
      const rows = (await client.query<AgentRow>(`select a.id,a.record,a.metadata_revision::text,c.record as configuration
        from agents a join agent_configuration_versions c on c.id=a.current_configuration_version_id and c.agent_id=a.id
        where a.workspace_id=$1 and a.archived_at is null order by a.id limit 1000`, [workspaceId])).rows
      const current = new Map<string, string>()
      const outdated: { id: string; name: string; version: string; revision: number; configurationVersionId: string
        assignedSkills: { skillId: string; version: string }[] }[] = []
      for (const row of rows) {
        const configuration = AgentConfigurationVersionSchema.parse(row.configuration)
        current.set(row.id, configuration.id)
        const assigned = configuration.assignedSkills.find(skill => skill.skillId === skillId)
        if (!assigned || assigned.version === head) continue
        outdated.push({ id: row.id, name: AgentSchema.parse(row.record).name, version: assigned.version,
          revision: Number(row.metadata_revision), configurationVersionId: configuration.id, assignedSkills: configuration.assignedSkills })
      }
      const outdatedIds = new Set(outdated.map(agent => agent.id))
      const workflowRows = (await client.query<{ id: string; record: unknown; revision: string; current_version_id: string;
        version: unknown }>(`select w.id,w.record,w.revision::text,w.current_version_id,v.record as version
        from workflows w join workflow_versions v on v.id=w.current_version_id and v.workspace_id=w.workspace_id
        where w.workspace_id=$1 and w.archived_at is null and v.execution_semantics_version=3 order by w.id limit 1000`, [workspaceId])).rows
      const workflows = workflowRows.flatMap(row => {
        const version = WorkflowVersionV3Schema.parse(row.version)
        const pins = version.agentConfigurationVersionIds
        // A workflow is affected when it uses an Agent on the old version, or an Agent already moved past its pin.
        if (!Object.keys(pins).some(agentId => outdatedIds.has(agentId) || current.get(agentId) !== pins[agentId])) return []
        const graph = WorkflowDefinitionV3Schema.parse(row.record)
        return [{ id: row.id, name: graph.name, revision: Number(row.revision), versionId: row.current_version_id, graph,
          currentPins: Object.fromEntries(Object.keys(pins).map(agentId => [agentId, current.get(agentId) ?? pins[agentId]!])) }]
      })
      return { head, outdated, workflows, locationRevision: Number(location.location_revision) }
    } finally { client.release() }
  }
}

function failure(kind: 'agent' | 'workflow', id: string, error: unknown) {
  const code = error instanceof DomainError ? error.code : 'INTERNAL_ERROR'
  const message = error instanceof DomainError ? error.message : 'The update could not be saved.'
  return { kind, id, code, message }
}
