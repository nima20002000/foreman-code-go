import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { AgentSchema, CiGetOutputSchema, CiArtifactsOutputSchema } from '@foreman-code/contracts'
import { ManagedWorkspaceSchema } from '@foreman-code/contracts/management'
import { JobTargetSchema } from '@foreman-code/contracts/jobs'
import { JobQueuePageSchema } from '@foreman-code/contracts/job-admission'
import { HarnessRegistryReadbackSchema, HostHarnessOverrideSaveResultSchema,
  HostHarnessInstanceCheckResultSchema } from '@foreman-code/contracts/harness-registry'
import { CurrentEditReadResultSchema, CurrentWorkflowReadResultSchema,
  SavedManagedWorkflowCommandResultSchema, ManualRunStartResultSchema,
  SavedRunDetailsSchema } from '@foreman-code/contracts/wave25'
import { RunPlacementGetResultSchema } from '@foreman-code/contracts/placement-readback'

// The integration runner supplies a disposable local application workspace with a
// paired Dexter build computer and qualified verification runtime. No provider or job is mocked.
const InputSchema = z.object({
  endpoint: z.url(), workspaceId: z.string().min(1),
  token: z.string().min(1), deniedToken: z.string().min(1),
  buildTarget: JobTargetSchema,
}).strict()
const harness = { harness: 'codex' as const, model: 'gpt-5.6-luna', reasoningEffort: 'medium' as const,
  serviceTier: 'standard' as const, sandbox: 'read-only' as const }

async function connect(endpoint: string, token: string) {
  const client = new Client({ name: 'Agent remote CI acceptance', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), {
    authProvider: { token: async () => token },
  }))
  return client
}
async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args }, { timeout: 180000 })
  // Do not print request bodies or fixture credentials on failure.
  expect(result.isError, `Public MCP operation ${name} failed`).not.toBe(true)
  return result.structuredContent
}

async function expectDenied(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args })
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain('ACCESS_DENIED')
}

it('real Codex medium runs current files on Dexter, reads logs and artifacts and reports the persisted build result', async () => {
  const path = process.env.FOREMAN_CODE_REMOTE_CI_ACCEPTANCE_INPUT
  if (!path) throw new Error('Provide FOREMAN_CODE_REMOTE_CI_ACCEPTANCE_INPUT for the disposable local/Dexter fixture.')
  const input = InputSchema.parse(JSON.parse(await readFile(path, 'utf8')))
  const endpoint = new URL(input.endpoint)
  expect(['127.0.0.1', 'localhost', '[::1]']).toContain(endpoint.hostname)
  expect(input.buildTarget.hostRef.kind).toBe('device')
  const mainHost = { kind: 'main' as const, mainId: input.buildTarget.mainId }
  const writer = await connect(input.endpoint, input.token)
  const denied = await connect(input.endpoint, input.deniedToken)
  let runId: string | undefined
  try {
    const tools = (await writer.listTools()).tools.map(tool => tool.name)
    expect(tools).toEqual(expect.arrayContaining(['ci_run', 'ci_get', 'ci_cancel', 'ci_logs_read',
      'ci_artifacts_list', 'ci_artifact_read', 'job_queue_list']))
    const workspace = ManagedWorkspaceSchema.parse(await call(writer, 'workspace_get', { workspaceId: input.workspaceId }))
    expect(workspace.locationValidation.status).toBe('ready')
    const inventory = HarnessRegistryReadbackSchema.parse(await call(writer, 'harness_registry_get', mainHost))
    const installation = inventory.installations.find(value => value.driverId === 'codex' && value.installed)!
    expect(installation).toBeDefined()
    const target = { hostRef: mainHost, applicationInstallationId: inventory.hostMetadata!.applicationInstallationId,
      harnessInstallationId: installation.harnessInstallationId, installationFingerprint: installation.installationFingerprint }
    const savedProfile = HostHarnessOverrideSaveResultSchema.parse(await call(writer, 'harness_instance_save', {
      commandId: randomUUID(), instanceId: randomUUID(), expectedRevision: 0, target,
      presetId: 'local-default:codex', enabled: true, configuration: harness,
    })).value
    const checked = HostHarnessInstanceCheckResultSchema.parse(await call(writer, 'harness_instance_check', {
      commandId: randomUUID(), instanceId: savedProfile.instanceId, expectedRevision: savedProfile.revision, target,
    }))
    expect(checked.proof.qualified).toBe(true)
    expect(checked.value.configuration).toEqual(harness)
    const selector = { instanceId: checked.value.instanceId, instanceRevision: checked.value.instanceRevision, target }
    const created = SavedManagedWorkflowCommandResultSchema.parse(await call(writer, 'workflow_create', {
      workspaceId: input.workspaceId, commandId: randomUUID(), name: 'Agent remote build acceptance', executionSemanticsVersion: 3,
    })).value
    const agentId = randomUUID()
    const nodeId = randomUUID()
    const prompt = 'Use only Foreman Code MCP tools for CI. Call ci_computers_list, then ci_run with suite build, '
      + `a unique commandId, no commit override and placementOverride ${JSON.stringify({ kind: 'explicit', target: input.buildTarget })}. `
      + 'Poll ci_get for the returned ticket until its process is terminal and publication finishes. '
      + 'Read ci_logs_read and ci_artifacts_list; read the summary revision with ci_artifact_read. '
      + 'Report ticketId, executionId, selected computer deviceId, process outcome, one log line, '
      + 'and the summary artifact sha256. Do not run shell builds or change files.'
    const agent = AgentSchema.parse({ id: agentId, name: 'Remote build agent', productRole: 'coder', harness: 'codex',
      model: 'gpt-5.6-luna', harnessConfiguration: harness, harnessProfileSelection: selector,
      prompt: { system: 'Complete the requested MCP job and report the observed results.' }, assignedSkills: [],
      graphqlTools: ['context_get', 'ci_computers_list', 'ci_run', 'ci_get', 'ci_cancel',
        'ci_logs_read', 'ci_artifacts_list', 'ci_artifact_read'] })
    const graph = { ...created.workflow, entryNodeId: nodeId, requiredAgentCount: 1, edges: [],
      approval: { handler: 'user' }, executionPolicy: { maxParallelism: 1, maxNodeExecutions: 1 },
      nodes: [{ id: nodeId, agentId, name: agent.name, position: { x: 0, y: 0 }, initialPrompt: prompt }] }
    const draftId = randomUUID()
    await call(writer, 'workflow_edit_v3', { action: 'stage_edits', commandId: randomUUID(), draftId,
      workspaceId: input.workspaceId, workflowId: graph.id, executionSemanticsVersion: 3,
      expectedRevision: created.revision, expectedWorkflowVersionId: null,
      expectedLocationRevision: workspace.locationRevision, expectedAgentConfigurationVersionIds: {}, graph,
      stagedAgents: [{ agent, baseRevision: null }] })
    const staged = CurrentEditReadResultSchema.parse(await call(writer, 'workflow_edits_get_v3', {
      action: 'read_edits', workspaceId: input.workspaceId, workflowId: graph.id, draftId,
    })).intent!
    await call(writer, 'workflow_edit_v3', { action: 'stop_and_save', workspaceId: input.workspaceId,
      workflowId: graph.id, draftId, intentId: staged.id, commandId: staged.advanceCommandId })
    const saved = CurrentWorkflowReadResultSchema.parse(await call(writer, 'workflow_saved_get_v3', {
      workspaceId: input.workspaceId, workflowId: graph.id,
    }))
    const start = { workspaceId: input.workspaceId, workflowId: graph.id, workflowVersionId: saved.version.id,
      commandId: randomUUID(), executionSemanticsVersion: 3, expectedWorkflowRevision: saved.revision,
      expectedAgentConfigurationVersionIds: saved.version.agentConfigurationVersionIds,
      expectedLocationRevision: workspace.locationRevision, input: {} }
    await expectDenied(denied, 'run_start', start)
    await expectDenied(denied, 'ci_run', {
      workspaceId: input.workspaceId, suite: 'build', commandId: randomUUID(),
    })
    const started = ManualRunStartResultSchema.parse(await call(writer, 'run_start', start))
    runId = started.run.id
    let result: z.infer<typeof SavedRunDetailsSchema> | undefined
    const deadline = Date.now() + 20 * 60_000
    while (Date.now() < deadline) {
      result = SavedRunDetailsSchema.parse(await call(writer, 'run_get', { workspaceId: input.workspaceId, runId }))
      if (result.executions.some(value => value.result)) break
      await delay(1000)
    }
    const execution = result?.executions.find(value => value.agentId === agentId)
    if (!execution) throw new Error('The remote build Agent execution was not recorded.')
    expect(execution.result?.outcome).toBe('succeeded')
    const placement = RunPlacementGetResultSchema.parse(await call(writer, 'run_node_placement_get', {
      workspaceId: input.workspaceId, workflowId: graph.id, runId, nodeId,
    }))
    expect(placement.readback).toMatchObject({ evidence: 'accepted', placement: { hostRef: mainHost } })
    const queued = JobQueuePageSchema.parse(await call(writer, 'job_queue_list', {
      workspaceId: input.workspaceId, initiatingExecutionId: execution.id,
    }))
    expect(queued.tickets).toHaveLength(1)
    const ticket = queued.tickets[0]!
    expect(ticket.initiatingAgent).toMatchObject({ runId, agentId, executionId: execution.id })
    expect(ticket.workflow).toBeNull()
    const scope = { workspaceId: input.workspaceId, ticketId: ticket.id }
    const ci = CiGetOutputSchema.parse(await call(writer, 'ci_get', scope))
    expect(ci.queue.selectedComputer?.target).toEqual(input.buildTarget)
    expect(ci.process).toMatchObject({ phase: 'terminal', outcome: 'succeeded', processStopped: true })
    expect(ci.publication).toBe('complete')
    expect(ci.summaryReport?.report.outcome).toBe('passed')
    const artifacts = CiArtifactsOutputSchema.parse(await call(writer, 'ci_artifacts_list', scope)).artifacts
    const summary = artifacts.find(value => value.path.endsWith('/summary.json'))!
    expect(summary).toBeDefined()
    const report = JSON.stringify(execution.result?.output)
    for (const value of [ticket.id, ci.executionId!, input.buildTarget.hostRef.kind === 'device'
      ? input.buildTarget.hostRef.deviceId : '', summary.sha256, 'succeeded']) expect(report).toContain(value)
    const logLines = ci.logTail.text.split('\n').map(line => line.trim()).filter(line => line.length > 4)
    expect(logLines.some(line => report.includes(line))).toBe(true)
    await expectDenied(denied, 'ci_get', scope)
    await expectDenied(denied, 'ci_artifacts_list', scope)
  } finally {
    try {
      if (runId) await call(writer, 'run_stop', { workspaceId: input.workspaceId, runId, commandId: randomUUID() })
    } finally {
      await denied.close()
      await writer.close()
    }
  }
}, 1800000)
