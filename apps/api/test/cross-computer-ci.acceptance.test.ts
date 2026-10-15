import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Client } from '@modelcontextprotocol/client'
import { CiComputersOutputSchema, CiGetOutputSchema } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import type { HarnessProfileSelection } from '@foreman-code/contracts/harness-registry'
import { ManualRunStartResultSchema, SavedRunDetailsSchema } from '@foreman-code/contracts/wave25'
import { expect, it } from 'vitest'
import { readCrossComputerCiInput, type CrossComputerCiInput } from './helpers/crossComputerCiInput.js'
import { listCiToolNames } from './helpers/crossComputerCiTools.js'
import { callCiTool, connectCiOperator, disableCiProfiles, expectCiDenied, prepareCiWorkflow, qualifyCiProfile,
  type PreparedCiWorkflow } from './helpers/crossComputerCiSetup.js'
import { createScenarioObservation, pollCiScenario, type RunningCiWorkflow,
  type ScenarioObservation } from './helpers/crossComputerCiObservation.js'
import { ciTerminal } from './helpers/crossComputerCiReadback.js'
import { verifyCiScenario } from './helpers/crossComputerCiVerification.js'

function startInput(workflow: PreparedCiWorkflow) {
  return {
    workspaceId: workflow.workspace.workspaceId, workflowId: workflow.graph.id,
    workflowVersionId: workflow.saved.version.id, commandId: randomUUID(), executionSemanticsVersion: 3,
    expectedWorkflowRevision: workflow.saved.revision,
    expectedAgentConfigurationVersionIds: workflow.saved.version.agentConfigurationVersionIds,
    expectedLocationRevision: workflow.locationRevision, input: {},
  }
}

async function verifyPrerequisites(client: Client, input: CrossComputerCiInput) {
  expect(await listCiToolNames(client)).toEqual(expect.arrayContaining([
    'ci_run', 'ci_get', 'ci_computers_list', 'ci_logs_read', 'ci_cancel',
    'workspace_get', 'workflow_create', 'workflow_edit_v3', 'workflow_edits_get_v3', 'workflow_saved_get_v3',
    'run_start', 'run_stop', 'run_get', 'run_executions_list', 'run_events_list', 'run_activities_get_v1',
    'run_node_placement_get', 'workflow_node_placement_choices',
    'harness_registry_get', 'harness_instance_save', 'harness_instance_check', 'harness_instances_list',
  ]))
  for (const workspace of input.workspaces) {
    // Agent computers need not build: the owner keeps Main out of the CI lane, so only listed CI computers are required.
    // Laptops join once their Worker update lands; placement simply uses them when ready. A round starts right after
    // a deploy, so give the configured CI computers a bounded window to finish their own update first.
    const deadline = Date.now() + 5 * 60_000
    let configured
    for (;;) {
      const listed = CiComputersOutputSchema.parse(await callCiTool(client, 'ci_computers_list', {
        workspaceId: workspace.workspaceId,
      }))
      configured = workspace.ciComputers.map(host =>
        listed.computers.find(value => JSON.stringify(value.hostRef) === JSON.stringify(host)))
      if (configured.some(computer => computer?.ready) || Date.now() > deadline) break
      await new Promise(resolve => setTimeout(resolve, 5_000))
    }
    expect(configured.every(Boolean), 'Every configured scenario CI computer is listed').toBe(true)
    expect(configured.some(computer => computer?.ready), 'A configured scenario CI computer is ready').toBe(true)
  }
}

async function prepareProfiles(client: Client, input: CrossComputerCiInput) {
  const profiles = new Map<string, HarnessProfileSelection>()
  for (const workspace of input.workspaces) {
    for (const computer of workspace.computers) {
      const key = JSON.stringify(computer.hostRef)
      if (!profiles.has(key)) profiles.set(key, await qualifyCiProfile(client, computer))
    }
  }
  return profiles
}

async function startWorkflows(client: Client, denied: Client, prepared: PreparedCiWorkflow[], running: RunningCiWorkflow[]) {
  const requests = prepared.map(workflow => ({ workflow, request: startInput(workflow) }))
  for (const { request, workflow } of requests) {
    await expectCiDenied(denied, 'run_start', request)
    await expectCiDenied(denied, 'ci_run', {
      workspaceId: workflow.workspace.workspaceId, suite: 'build', commandId: randomUUID(),
    })
  }
  const results = await Promise.allSettled(requests.map(async ({ workflow, request }) => {
    const result = ManualRunStartResultSchema.parse(await callCiTool(client, 'run_start', request))
    running.push({ ...workflow, runId: result.run.id })
  }))
  const rejected = results.find(result => result.status === 'rejected')
  if (rejected?.status === 'rejected') throw rejected.reason
  expect(new Set(running.map(workflow => workflow.runId)).size).toBe(prepared.length)
}

async function verifyIsolation(client: Client, workflows: RunningCiWorkflow[], observation: ScenarioObservation) {
  for (const workflow of workflows) {
    const foreign = workflows.find(value => value.workspace.workspaceId !== workflow.workspace.workspaceId)!
    const run = await client.callTool({ name: 'run_get', arguments: {
      workspaceId: foreign.workspace.workspaceId, runId: workflow.runId,
    } }, { timeout: 30_000 })
    expect(run.isError, 'A Run cannot be read through another workspace').toBe(true)
    expect(decodeMcpToolResult(run)).not.toHaveProperty('run')
    for (const ticket of observation.tickets.values()) {
      if (ticket.runId !== workflow.runId) continue
      for (const name of ['ci_get', 'ci_logs_read']) {
        const result = await client.callTool({ name, arguments: {
          workspaceId: foreign.workspace.workspaceId, ticketId: ticket.ticketId,
        } }, { timeout: 30_000 })
        expect(result.isError, `${name} must preserve the ticket workspace`).toBe(true)
        const body = decodeMcpToolResult(result)
        for (const field of ['run', 'partitions', 'text', 'parts']) expect(body).not.toHaveProperty(field)
      }
    }
  }
}

async function verifyExclusions(client: Client, input: CrossComputerCiInput, observation: ScenarioObservation) {
  for (const excluded of input.excludedComputers) {
    const listed = CiComputersOutputSchema.parse(await callCiTool(client, 'ci_computers_list', {
      workspaceId: excluded.workspaceId,
    }))
    const computer = listed.computers.find(value => JSON.stringify(value.hostRef) === JSON.stringify(excluded.hostRef))
    if (computer) {
      expect(computer.ready).toBe(false)
      expect(computer.reasons.length).toBeGreaterThan(0)
    }
    observation.exclusions.push({ workspaceId: excluded.workspaceId, hostRef: excluded.hostRef,
      observedAt: new Date().toISOString(), reasons: computer?.reasons ?? ['Not advertised as a CI computer.'] })
    for (const ticket of observation.tickets.values()) {
      expect(ticket.timeline.some(sample => JSON.stringify(sample.run.computer?.hostRef)
        === JSON.stringify(excluded.hostRef)), 'Unavailable computers must not execute scenario tickets').toBe(false)
    }
  }
}

async function cleanupFailedRound(client: Client, workflows: RunningCiWorkflow[], observation: ScenarioObservation) {
  const errors: string[] = []
  for (const workflow of workflows) {
    try {
      const scope = { workspaceId: workflow.workspace.workspaceId, runId: workflow.runId }
      await callCiTool(client, 'run_stop', { ...scope, commandId: randomUUID() })
      const deadline = Date.now() + 120_000
      let details = SavedRunDetailsSchema.parse(await callCiTool(client, 'run_get', { ...scope, detail: 'full' }))
      while ((details.run.executionState !== 'completed' || details.cleanupPending) && Date.now() < deadline) {
        await delay(1000)
        details = SavedRunDetailsSchema.parse(await callCiTool(client, 'run_get', { ...scope, detail: 'full' }))
      }
      if (details.run.executionState !== 'completed' || details.cleanupPending) {
        errors.push(`Run ${workflow.runId} has not confirmed cleanup.`)
      }
      const unknown = details.executions.filter(execution =>
        workflow.assignments.some(agent => agent.agentId === execution.agentId && agent.suite)
        && !observation.groups.has(execution.id))
      if (unknown.length) {
        errors.push(`Run ${workflow.runId} has ${unknown.length} CI Agents without discoverable ticket groups; inspect production.`)
      }
    } catch {
      errors.push(`Run ${workflow.runId} Stop or cleanup read failed.`)
    }
  }
  for (const ticket of observation.tickets.values()) {
    try {
      const scope = { workspaceId: ticket.workspaceId, ticketId: ticket.ticketId }
      let readback = CiGetOutputSchema.parse(await callCiTool(client, 'ci_get', scope))
      if (!ciTerminal(readback.run.state)) await callCiTool(client, 'ci_cancel', scope)
      const deadline = Date.now() + 120_000
      do {
        readback = CiGetOutputSchema.parse(await callCiTool(client, 'ci_get', scope))
        if (ciTerminal(readback.run.state)) break
        await delay(1000)
      } while (Date.now() < deadline)
      ticket.latest = readback.run
      if (!ciTerminal(readback.run.state)) errors.push(`CI ticket ${ticket.ticketId} has not confirmed cancellation.`)
    } catch {
      errors.push(`CI ticket ${ticket.ticketId} cancellation or read failed.`)
    }
  }
  return errors
}

it('runs concurrent projects through Agent Host CI with isolated readback twice in a row', async () => {
  const input = await readCrossComputerCiInput()
  await mkdir(input.evidenceDirectory, { recursive: true, mode: 0o700 })
  const invocationId = randomUUID()
  const clients: Client[] = []
  let profiles = new Map<string, HarnessProfileSelection>()
  const redact = (text: string) => text.replaceAll(input.token, '[redacted]').replaceAll(input.deniedToken, '[redacted]')
  try {
    const writer = await connectCiOperator(input.endpoint, input.token)
    clients.push(writer)
    const denied = await connectCiOperator(input.endpoint, input.deniedToken)
    clients.push(denied)
    for (const round of [1, 2]) {
      const workflows: RunningCiWorkflow[] = []
      const observation = createScenarioObservation()
      const evidence = { invocationId, round, startedAt: new Date().toISOString(), finishedAt: null as string | null,
        status: 'running' as 'running' | 'passed' | 'failed', failure: null as string | null, cleanupErrors: [] as string[] }
      const persist = async () => {
        await writeFile(join(input.evidenceDirectory, `cross-computer-ci-${invocationId}-round-${round}.json`),
          redact(JSON.stringify({ ...evidence,
            workflows: workflows.map(workflow => ({ workspaceId: workflow.workspace.workspaceId,
              workflowId: workflow.graph.id, workflowVersionId: workflow.saved.version.id, runId: workflow.runId,
              project: workflow.workspace.project, repository: workflow.repository,
              assignments: workflow.assignments.map(agent => ({ agentId: agent.agentId, nodeId: agent.nodeId,
                suite: agent.suite, hostRef: agent.profile.target.hostRef })) })),
            tickets: [...observation.tickets.values()], groups: Object.fromEntries(observation.groups),
            reports: Object.fromEntries(observation.reports), runs: [...observation.runs.values()],
            agentStates: Object.fromEntries(observation.agentStates),
            queueWitness: observation.queueWitness, concurrencyWitness: observation.concurrencyWitness,
            activities: Object.fromEntries([...observation.activities].map(([runId, items]) => [runId, [...items.values()]])),
            exclusions: observation.exclusions,
          }, null, 2)), { mode: 0o600 })
      }
      await persist()
      try {
        if (round === 1) {
          await verifyPrerequisites(writer, input)
          profiles = await prepareProfiles(writer, input)
        }
        const prepared: PreparedCiWorkflow[] = []
        for (const workspace of input.workspaces) {
          for (const index of [1, 2]) prepared.push(await prepareCiWorkflow(writer, workspace, profiles, round, index))
        }
        expect(new Set(prepared.map(workflow => workflow.repository)).size, 'The projects use distinct repositories')
          .toBe(input.workspaces.length)
        await startWorkflows(writer, denied, prepared, workflows)
        await persist()
        await pollCiScenario(writer, workflows, observation, persist)
        await verifyCiScenario(writer, workflows, observation, input)
        await verifyIsolation(writer, workflows, observation)
        await verifyExclusions(writer, input, observation)
        evidence.status = 'passed'
      } catch (error) {
        evidence.status = 'failed'
        evidence.failure = redact(error instanceof Error ? error.message : 'Scenario failed.')
        await persist()
        evidence.cleanupErrors = await cleanupFailedRound(writer, workflows, observation)
        throw new Error(`Cross-computer CI round ${round} failed; inspect its private evidence JSON.`,
          { cause: error })
      } finally {
        evidence.finishedAt = new Date().toISOString()
        await persist()
      }
    }
  } finally {
    if (clients[0] && profiles.size) await disableCiProfiles(clients[0], profiles.values())
    const closed = await Promise.allSettled(clients.map(client => client.close()))
    expect(closed.every(result => result.status === 'fulfilled'), 'Close every scenario MCP client').toBe(true)
  }
}, 9 * 60 * 60_000)
