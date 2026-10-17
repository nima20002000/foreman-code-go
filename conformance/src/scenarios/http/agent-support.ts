import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import {
  AgentConfigurationVersionSchema, CodexHarnessConfigurationSchema,
  type Agent, type ResolvedSkill,
} from '@foreman-code/contracts'
import { AgentMutationResultSchema, AgentUpdateInputSchema, type AgentUpdateInput } from '@foreman-code/contracts/management'
import { assertResponse } from '../../assertions.js'
import type { ScenarioContext } from '../../scenario.js'

export const agentCollectionRoute = '/api/management/workspaces/:workspaceId/agents'
export const agentRoute = `${agentCollectionRoute}/:agentId`

/** The frozen TS configuration digest hashes ordered JSON bytes, not graph canonical JSON. */
export function codexConfigurationVersion(
  workspaceId: string,
  agent: Agent,
  version: number,
  createdAt: string,
  resolvedSkills: ResolvedSkill[] = [],
) {
  assert.ok(agent.configurationVersionId)
  const configuration = CodexHarnessConfigurationSchema.parse(agent.harnessConfiguration)
  const harness = {
    harness: 'codex' as const, model: configuration.model, reasoningEffort: configuration.reasoningEffort,
    sandbox: configuration.sandbox, serviceTier: configuration.serviceTier,
    ...(configuration.accountId ? { accountId: configuration.accountId } : {}),
    ...(configuration.advanced ? { advanced: configuration.advanced } : {}),
  }
  const content = {
    workspaceId,
    ...(agent.harnessProfileSelection ? { harnessProfileSelection: agent.harnessProfileSelection } : {}),
    ...(agent.nativeTools ? { nativeTools: agent.nativeTools } : {}),
    agentId: agent.id, productRole: agent.productRole,
    prompt: agent.prompt ?? {}, assignedSkills: agent.assignedSkills ?? [],
    ...(agent.graphqlTools ? { graphqlTools: agent.graphqlTools } : {}),
    harness,
    ...(resolvedSkills.length ? { resolvedSkills } : {}),
    instructionDelivery: 'native-v1' as const,
  }
  const contentHash = `sha256:${createHash('sha256').update(JSON.stringify(content), 'utf8').digest('hex')}`
  return AgentConfigurationVersionSchema.parse({
    ...content, id: agent.configurationVersionId, version, contentHash, createdAt,
  })
}

export async function updateUnreferencedAgent(
  ctx: ScenarioContext,
  workspaceId: string,
  previous: ReturnType<typeof AgentMutationResultSchema.parse>['value'],
  changes: Pick<AgentUpdateInput, 'prompt' | 'assignedSkills'>,
) {
  assert.ok(previous.agent.configurationVersionId)
  const input = AgentUpdateInputSchema.parse({
    workspaceId, agentId: previous.agent.id, commandId: randomUUID(),
    expectedRevision: previous.metadataRevision,
    expectedConfigurationVersionId: previous.agent.configurationVersionId, ...changes,
  })
  const path = `/api/management/workspaces/${workspaceId}/agents/${previous.agent.id}`
  const response = await ctx.http.request('PATCH', path, { body: input })
  const updated = AgentMutationResultSchema.parse(response.body).value
  assertResponse(response, {
    status: 200,
    body: { value: {
      agent: { ...previous.agent, ...changes, configurationVersionId: '<id>', updatedAt: '<timestamp>' },
      metadataRevision: previous.metadataRevision + 1, affectedWorkflowIds: [],
    }, replayed: false },
  }, [
    { pointer: '/body/value/agent/configurationVersionId', kind: 'id' },
    { pointer: '/body/value/agent/updatedAt', kind: 'timestamp' },
  ])
  assert.notEqual(updated.agent.configurationVersionId, previous.agent.configurationVersionId)
  return { input, updated }
}
