import { createHash, randomUUID } from 'node:crypto'

import {
  AgentConfigurationVersionSchema,
  AgentSchema,
  type Agent,
  type AgentConfigurationVersion,
} from '@graphql/contracts'
import type pg from 'pg'

import { DomainError } from '../errors.js'

export function configurationInput(
  workspaceId: string,
  agent: Agent,
  current?: AgentConfigurationVersion,
) {
  if (agent.harness && agent.harnessConfiguration
    && agent.harness !== agent.harnessConfiguration.harness) {
    throw new DomainError('AGENT_HARNESS_MISMATCH', 'The agent harness and its configuration must match.', 400)
  }
  const harness = agent.harnessConfiguration?.harness ?? agent.harness ?? current?.harness.harness ?? 'codex'
  const prompt = agent.prompt ?? current?.prompt ?? {}
  const assignedSkills = agent.assignedSkills ?? current?.assignedSkills ?? []
  if (harness === 'opencode') {
    const suppliedHarness = agent.harnessConfiguration?.harness === 'opencode'
      ? agent.harnessConfiguration
      : undefined
    const currentHarness = suppliedHarness
      ?? (current?.harness.harness === 'opencode' ? current.harness : undefined)
    if (currentHarness?.autoApprove) {
      throw new DomainError('OPENCODE_SETTING_UNSUPPORTED', 'Automatic permission approval is disabled for Product Agent runs.', 400)
    }
    const variant = agent.effort === 'low' || agent.effort === 'high' || agent.effort === 'max'
      ? agent.effort
      : currentHarness?.variant ?? 'max'
    return {
      workspaceId,
      agentId: agent.id,
      productRole: agent.productRole ?? current?.productRole,
      prompt,
      assignedSkills,
      harness: {
        harness,
        model: agent.model ?? currentHarness?.model ?? 'opencode-go/deepseek-v4.1-flash',
        variant,
        nativeAgent: currentHarness?.nativeAgent ?? 'build',
        thinking: currentHarness?.thinking ?? false,
        autoApprove: false,
      },
    } as const
  }

  const suppliedHarness = agent.harnessConfiguration?.harness === 'codex'
    ? agent.harnessConfiguration
    : undefined
  const currentHarness = suppliedHarness
    ?? (current?.harness.harness === 'codex' ? current.harness : undefined)
  return {
    workspaceId,
    agentId: agent.id,
    productRole: agent.productRole ?? current?.productRole,
    prompt,
    assignedSkills,
    harness: {
      harness,
      model: agent.model ?? currentHarness?.model ?? 'gpt-5.6-luna',
      reasoningEffort: agent.effort ?? currentHarness?.reasoningEffort ?? 'medium',
      sandbox: currentHarness?.sandbox ?? 'read-only',
      serviceTier: (agent.fastMode ?? (currentHarness?.serviceTier === 'priority')) ? 'priority' : 'standard',
    },
  } as const
}

/** Lock every referenced agent in the same order before taking row locks. */
export async function lockAgentConfigurations(client: pg.PoolClient, agentIds: readonly string[]): Promise<void> {
  for (const agentId of [...new Set(agentIds)].sort()) {
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [`agent:${agentId}`])
  }
}

/** Used by both board and standalone saves, inside the caller's transaction. */
export async function saveAgentConfiguration(
  client: pg.PoolClient,
  workspaceId: string,
  input: Agent,
  mustExist = false,
): Promise<Agent> {
  const parsed = AgentSchema.parse(input)
  await lockAgentConfigurations(client, [parsed.id])
  const existingRow = await client.query<{
    workspace_id: string
    current_configuration_version_id: string | null
    record: unknown
  }>('select workspace_id, current_configuration_version_id, record from agents where id = $1 for update', [parsed.id])
  const existing = existingRow.rows[0]
  if (!existing && mustExist) {
    throw new DomainError('AGENT_NOT_FOUND', `Agent '${parsed.id}' was not found.`, 404)
  }
  if (existing && existing.workspace_id !== workspaceId) {
    throw new DomainError('AGENT_WORKSPACE_MISMATCH', `Agent '${parsed.id}' belongs to another workspace.`, 409)
  }
  // Check before hashing or writing, including apparently unchanged snapshots.
  if (parsed.configurationVersionId !== (existing?.current_configuration_version_id ?? undefined)) {
    throw new DomainError('AGENT_CONFIGURATION_CONFLICT', 'These agent settings are out of date. Reload the agent before saving.', 409)
  }

  const currentConfiguration = existing?.current_configuration_version_id
    ? await client.query<{ record: unknown }>(
        'select record from agent_configuration_versions where id = $1 and workspace_id = $2 and agent_id = $3',
        [existing.current_configuration_version_id, workspaceId, parsed.id],
      )
    : undefined
  const current = currentConfiguration?.rows[0]
    ? AgentConfigurationVersionSchema.parse(currentConfiguration.rows[0].record)
    : undefined
  if (!current && (mustExist || existing?.current_configuration_version_id)) {
    throw new DomainError('AGENT_CONFIGURATION_UNAVAILABLE', 'This agent has no persisted configuration to edit.', 409)
  }
  const nextInput = configurationInput(workspaceId, parsed, current)
  const nextHash = `sha256:${createHash('sha256').update(JSON.stringify(nextInput)).digest('hex')}`
  const now = new Date().toISOString()

  if (!existing) {
    const placeholder = AgentSchema.parse({ id: parsed.id, name: parsed.name, role: parsed.role, productRole: parsed.productRole })
    await client.query(
      `insert into agents (id, workspace_id, current_configuration_version_id, record)
       values ($1, $2, null, $3::jsonb)`,
      [parsed.id, workspaceId, JSON.stringify(placeholder)],
    )
  }

  let configuration = current
  if (!configuration || configuration.contentHash !== nextHash) {
    const versionResult = await client.query<{ next_version: number }>(
      'select coalesce(max(version), 0) + 1 as next_version from agent_configuration_versions where agent_id = $1',
      [parsed.id],
    )
    const version = Number(versionResult.rows[0]?.next_version ?? 1)
    configuration = AgentConfigurationVersionSchema.parse({
      ...nextInput,
      id: `${parsed.id}-config-v${version}-${randomUUID()}`,
      version,
      contentHash: nextHash,
      createdAt: now,
    })
    await client.query(
      `insert into agent_configuration_versions (id, workspace_id, agent_id, version, record)
       values ($1, $2, $3, $4, $5::jsonb)`,
      [configuration.id, workspaceId, parsed.id, version, JSON.stringify(configuration)],
    )
  }

  const previousAgent = existing ? AgentSchema.parse(existing.record) : undefined
  const harness = configuration.harness
  // Operational state remains server-owned on both save paths.
  const agent = AgentSchema.parse({
    ...previousAgent,
    id: parsed.id,
    name: parsed.name,
    description: parsed.description,
    role: parsed.role,
    productRole: configuration.productRole,
    harness: harness.harness,
    model: harness.model,
    effort: harness.harness === 'codex' ? harness.reasoningEffort : harness.variant,
    fastMode: harness.harness === 'codex' ? harness.serviceTier === 'priority' : undefined,
    harnessConfiguration: harness,
    configurationVersionId: configuration.id,
    prompt: configuration.prompt,
    assignedSkills: configuration.assignedSkills,
    createdAt: previousAgent?.createdAt ?? parsed.createdAt ?? now,
    updatedAt: now,
  })
  await client.query(
    `update agents
     set current_configuration_version_id = $2, record = $3::jsonb
     where id = $1 and workspace_id = $4`,
    [agent.id, configuration.id, JSON.stringify(agent), workspaceId],
  )
  return agent
}
