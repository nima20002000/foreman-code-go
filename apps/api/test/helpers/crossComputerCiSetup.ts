import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { expect } from 'vitest'
import { z } from 'zod'
import { ApiErrorSchema, withAdvancedDefaults, type Agent } from '@foreman-code/contracts'
import { ManagedWorkspaceSchema } from '@foreman-code/contracts/management'
import { HarnessRegistryReadbackSchema, HostHarnessOverrideSaveResultSchema,
  HostHarnessInstanceCheckResultSchema, HostHarnessOverrideListSchema, type HarnessProfileSelection } from '@foreman-code/contracts/harness-registry'
import { NodePlacementChoicesResultSchema } from '@foreman-code/contracts/placement-readback'
import { CurrentEditReadResultSchema, CurrentWorkflowReadResultSchema, SavedManagedWorkflowCommandResultSchema,
  type WorkflowDefinitionV3 } from '@foreman-code/contracts/wave25'
import { buildCrossComputerCiGraph, ciHarness, projectSuites, type ScenarioAgent } from './crossComputerCiGraph.js'
import type { ScenarioComputer, ScenarioWorkspace } from './crossComputerCiInput.js'

type SavedCiWorkflow = z.infer<typeof CurrentWorkflowReadResultSchema>

export async function connectCiOperator(endpoint: string, token: string): Promise<Client> {
  const client = new Client({ name: 'Cross-computer CI acceptance', version: '1' })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }))
  } catch (error) {
    await client.close()
    throw error
  }
  return client
}

export function toolErrorCode(result: Awaited<ReturnType<Client['callTool']>>): string | null {
  const content = result.content.find(item => item.type === 'text')
  if (content?.type !== 'text') return null
  let body: unknown
  try {
    body = JSON.parse(content.text)
  } catch (error) {
    if (error instanceof SyntaxError) return null
    throw error
  }
  const parsed = z.object({ error: ApiErrorSchema }).safeParse(body)
  return parsed.success ? parsed.data.error.code : null
}

export async function callCiTool(client: Pick<Client, 'callTool'>, name: string, args: Record<string, unknown>) {
  const result = await callCiToolResult(client, name, args)
  const code = result.isError ? toolErrorCode(result) : null
  const detail = result.isError ? JSON.stringify(result.structuredContent ?? result.content).slice(0, 2000) : ''
  expect(result.isError, `Public MCP operation ${name} failed${code ? ` (${code})` : ''}: ${detail}`).not.toBe(true)
  return decodeMcpToolResult(result)
}

export async function callCiToolResult(client: Pick<Client, 'callTool'>, name: string, args: Record<string, unknown>) {
  const pendingDeadline = Date.now() + 5 * 60_000
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await client.callTool({ name, arguments: args }, { timeout: 180_000 })
    const code = result.isError ? toolErrorCode(result) : null
    if (code === 'ACTIVITY_SNAPSHOT_CONFLICT' && ['run_get', 'run_activities_get_v1'].includes(name) && attempt < 4) {
      await delay(10)
      continue
    }
    // A loaded Main may time out a read; the error is marked retryable and reads are side-effect free.
    // A busy device answers with a retryable DEVICE_BUSY; the same request is safe to send again.
    if (code === 'DEVICE_BUSY' && Date.now() < pendingDeadline) {
      await delay(2_000)
      attempt--
      continue
    }
    if (code === 'DATABASE_READ_TIMEOUT' && /_(get|list|read)(_v\d+)?$/.test(name) && Date.now() < pendingDeadline) {
      await delay(1_000)
      attempt--
      continue
    }
    // Command deadlines are retryable by contract with the original input.
    if ((code === 'COMMAND_DATABASE_TIMEOUT' || code === 'COMMAND_LOCK_TIMEOUT') && Date.now() < pendingDeadline) {
      await delay(1_000)
      attempt--
      continue
    }
    // A reconnected Worker rechecks its Agent profiles first; Start retries the same command meanwhile.
    if (code === 'HARNESS_PROFILE_CHECK_PENDING' && name === 'run_start' && Date.now() < pendingDeadline) {
      await delay(100)
      attempt--
      continue
    }
    return result
  }
  throw new Error('The activity read retry budget was exhausted.')
}

export async function expectCiDenied(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args }, { timeout: 30_000 })
  expect(result.isError, `${name} must reject the denied caller`).toBe(true)
  expect(toolErrorCode(result)).toBe('ACCESS_DENIED')
}

export async function qualifyCiProfile(client: Client, computer: ScenarioComputer): Promise<HarnessProfileSelection> {
  const inventory = HarnessRegistryReadbackSchema.parse(await callCiTool(client, 'harness_registry_get', computer.hostRef))
  const metadata = inventory.hostMetadata
  if (!metadata) throw new Error(`${computer.name} has no harness inventory.`)
  expect(metadata.hostRef).toEqual(computer.hostRef)
  if (computer.registration) {
    expect(metadata.connection?.phase).toBe('ready')
    expect(metadata.connection?.binding).toMatchObject(computer.registration)
  }
  const installation = inventory.installations.find(value => value.driverId === 'codex' && value.installed)
  if (!installation?.installationFingerprint) throw new Error(`${computer.name} needs an installed Codex harness.`)
  const target = {
    hostRef: computer.hostRef,
    applicationInstallationId: metadata.applicationInstallationId,
    harnessInstallationId: installation.harnessInstallationId,
    installationFingerprint: installation.installationFingerprint,
  }
  const profile = HostHarnessOverrideSaveResultSchema.parse(await callCiTool(client, 'harness_instance_save', {
    commandId: randomUUID(), instanceId: randomUUID(), expectedRevision: 0,
    target, presetId: 'local-default:codex', enabled: true, configuration: ciHarness,
  })).value
  const checked = HostHarnessInstanceCheckResultSchema.parse(await callCiTool(client, 'harness_instance_check', {
    commandId: randomUUID(), instanceId: profile.instanceId, expectedRevision: profile.revision, target,
  }))
  expect(checked.proof.qualified, `${computer.name} Codex profile qualification`).toBe(true)
  expect(checked.value.configuration).toEqual(withAdvancedDefaults(ciHarness))
  return { instanceId: checked.value.instanceId, instanceRevision: checked.value.instanceRevision, target }
}

/** Disables the invocation's profiles so later restarts do not recheck every scenario profile ever created. */
export async function disableCiProfiles(client: Client, profiles: Iterable<HarnessProfileSelection>) {
  for (const profile of profiles) {
    const { target } = profile
    const listed = HostHarnessOverrideListSchema.parse(await callCiTool(client, 'harness_instances_list', {
      hostRef: target.hostRef, applicationInstallationId: target.applicationInstallationId,
    }))
    const saved = listed.overrides.find(value => value.instanceId === profile.instanceId)
    if (!saved?.enabled) continue
    await callCiTool(client, 'harness_instance_save', {
      commandId: randomUUID(), instanceId: saved.instanceId, expectedRevision: saved.revision,
      target: saved.target, presetId: saved.presetId, enabled: false, configuration: saved.configuration,
    })
  }
}

async function saveGraph(client: Client, input: {
  graph: WorkflowDefinitionV3
  revision: number
  versionId: string | null
  configurations: Record<string, string>
  agents?: Agent[]
}): Promise<SavedCiWorkflow> {
  const scope = { workspaceId: input.graph.workspaceId, workflowId: input.graph.id }
  const draftId = randomUUID()
  await callCiTool(client, 'workflow_edit_v3', {
    ...scope, action: 'stage_edits', commandId: randomUUID(), draftId, executionSemanticsVersion: 3,
    expectedRevision: input.revision, expectedWorkflowVersionId: input.versionId,
    expectedAgentConfigurationVersionIds: input.configurations,
    graph: input.graph,
    ...(input.agents ? { stagedAgents: input.agents.map(agent => ({ agent, baseRevision: null })) } : {}),
  })
  const staged = CurrentEditReadResultSchema.parse(await callCiTool(client, 'workflow_edits_get_v3', {
    ...scope, action: 'read_edits', draftId,
  })).intent
  if (!staged) throw new Error('The staged CI workflow was not persisted.')
  await callCiTool(client, 'workflow_edit_v3', {
    ...scope, action: 'stop_and_save', draftId, intentId: staged.id, commandId: staged.advanceCommandId,
  })
  return CurrentWorkflowReadResultSchema.parse(await callCiTool(client, 'workflow_saved_get_v3', scope))
}

export type PreparedCiWorkflow = {
  workspace: ScenarioWorkspace
  assignments: ScenarioAgent[]
  graph: WorkflowDefinitionV3
  saved: SavedCiWorkflow
  locationRevision: number
  repository: string
}

export async function prepareCiWorkflow(client: Client, workspace: ScenarioWorkspace,
  profiles: Map<string, HarnessProfileSelection>, round: number, index: number): Promise<PreparedCiWorkflow> {
  const managed = ManagedWorkspaceSchema.parse(await callCiTool(client, 'workspace_get', { workspaceId: workspace.workspaceId }))
  expect(managed.locationValidation.status).toBe('ready')
  const repository = managed.workspace.repository
  if (!repository) throw new Error(`${workspace.project} workspace needs its GitHub repository configured.`)
  const created = SavedManagedWorkflowCommandResultSchema.parse(await callCiTool(client, 'workflow_create', {
    workspaceId: workspace.workspaceId, commandId: randomUUID(),
    name: `Cross-computer CI ${workspace.project} round ${round} workflow ${index}`, executionSemanticsVersion: 3,
  })).value
  const suites = [null, ...projectSuites[workspace.project]]
  const assignments: ScenarioAgent[] = suites.map((suite, index) => {
    const computer = workspace.computers[Math.max(0, index - 1) % workspace.computers.length]!
    const profile = profiles.get(JSON.stringify(computer.hostRef))
    if (!profile) throw new Error(`Missing qualified profile for ${computer.name}.`)
    return { agentId: randomUUID(), nodeId: randomUUID(), profile, suite,
      name: `${computer.name} ${suite ?? 'coordinator'}` }
  })
  const built = buildCrossComputerCiGraph(created.workflow, assignments)
  const first = await saveGraph(client, {
    graph: built.graph, agents: built.agents, revision: created.revision, versionId: null,
    configurations: {},
  })
  for (const assignment of assignments) {
    const choices = NodePlacementChoicesResultSchema.parse(await callCiTool(client, 'workflow_node_placement_choices', {
      workspaceId: workspace.workspaceId, workflowId: built.graph.id, nodeId: assignment.nodeId,
      agentConfigurationVersionId: first.version.agentConfigurationVersionIds[assignment.agentId],
    }))
    const selected = choices.choices.find(choice => choice.availability === 'ready'
      && JSON.stringify(choice.placement.hostRef) === JSON.stringify(assignment.profile.target.hostRef)
      && choice.placement.instanceId === assignment.profile.instanceId)
    if (!selected) {
      throw new Error(`No approved ready source/root placement for ${assignment.name}: wanted `
        + `${JSON.stringify({ hostRef: assignment.profile.target.hostRef, instanceId: assignment.profile.instanceId })}; `
        + `choices ${JSON.stringify(choices.choices.map(choice => ({ availability: choice.availability, reason: choice.reason,
          hostRef: choice.placement.hostRef, instanceId: choice.placement.instanceId })))}`)
    }
    assignment.placement = selected.placement
  }
  // The placement edit builds on the definition the first save published, with its version stamp.
  const { graph } = buildCrossComputerCiGraph(first.version.definition, assignments)
  const saved = await saveGraph(client, {
    graph, revision: first.revision, versionId: first.version.id,
    configurations: first.version.agentConfigurationVersionIds,
  })
  const savedPlacements = saved.version.definition.nodes.map(node => node.kind === 'job' ? null : node.placement)
  expect(savedPlacements).toEqual(assignments.map(assignment => assignment.placement))
  return { workspace, assignments, graph, saved, locationRevision: managed.locationRevision,
    repository: `${repository.owner}/${repository.name}` }
}
