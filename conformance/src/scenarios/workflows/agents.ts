import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  CodexHarnessConfigurationSchema, DEFAULT_AGENT_DEFAULTS, DEFAULT_CODEX_ADVANCED_CONFIGURATION,
  DEFAULT_HARNESS_DEFAULTS, type CodexHarnessConfiguration,
} from '@foreman-code/contracts'
import { AgentCreateInputSchema, AgentMutationResultSchema } from '@foreman-code/contracts/management'
import { assertResponse } from '../../assertions.js'
import type { ScenarioContext } from '../../scenario.js'

export function independentCodexSessions() {
  return CodexHarnessConfigurationSchema.parse({ ...DEFAULT_HARNESS_DEFAULTS.codex,
    advanced: { ...DEFAULT_CODEX_ADVANCED_CONFIGURATION, sessionPersistence: 'ephemeral' },
  })
}

export async function createCodexAgent(
  ctx: ScenarioContext,
  workspaceId: string,
  options: { id?: string; name: string; configuration?: CodexHarnessConfiguration; systemPrompt?: string },
) {
  const configuration = options.configuration ?? DEFAULT_HARNESS_DEFAULTS.codex
  const nativeTools = DEFAULT_AGENT_DEFAULTS.coder.nativeTools
  const input = AgentCreateInputSchema.parse({
    workspaceId, commandId: randomUUID(), agentId: options.id ?? `agent-${randomUUID()}`,
    name: options.name, productRole: 'coder', configuration,
    prompt: { system: options.systemPrompt ?? 'Use only the isolated conformance task and its accepted inputs.' },
    assignedSkills: [], nativeTools,
  })
  const response = await ctx.http.request('POST', `/api/management/workspaces/${workspaceId}/agents`, { body: input })
  const result = AgentMutationResultSchema.parse(response.body)
  assertResponse(response, { status: 201, body: {
    value: { agent: {
      id: input.agentId, name: input.name, productRole: 'coder',
      harness: 'codex', model: configuration.model, effort: configuration.reasoningEffort,
      fastMode: configuration.serviceTier === 'priority', harnessConfiguration: configuration,
      configurationVersionId: '<id>', prompt: input.prompt, assignedSkills: [], nativeTools,
      createdAt: '<timestamp>', updatedAt: '<timestamp>',
    }, metadataRevision: 1 }, replayed: false,
  } }, [
    { pointer: '/body/value/agent/configurationVersionId', kind: 'id' },
    { pointer: '/body/value/agent/createdAt', kind: 'timestamp' },
    { pointer: '/body/value/agent/updatedAt', kind: 'timestamp' },
  ])
  assert.ok(result.value.agent.configurationVersionId)
  assert.equal(result.value.agent.createdAt, result.value.agent.updatedAt)
  return result.value
}
