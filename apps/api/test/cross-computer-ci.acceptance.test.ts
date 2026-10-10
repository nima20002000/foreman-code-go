import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Client } from '@modelcontextprotocol/client'
import { expect, it } from 'vitest'
import { CiGetOutputSchema } from '@foreman-code/contracts'
import { JobQueuePageSchema } from '@foreman-code/contracts/job-admission'
import { JobAuthoringChoicesRecordSchema } from '@foreman-code/contracts/job-verification'
import { HarnessRegistryReadbackSchema, type HarnessProfileSelection } from '@foreman-code/contracts/harness-registry'
import { ManualRunStartResultSchema, SavedRunDetailsSchema } from '@foreman-code/contracts/wave25'
import { readCrossComputerCiInput, type CrossComputerCiInput } from './helpers/crossComputerCiInput.js'
import { projectSuites } from './helpers/crossComputerCiGraph.js'
import { listCiToolNames } from './helpers/crossComputerCiTools.js'
import { callCiTool, connectCiOperator, expectCiDenied, prepareCiWorkflow, qualifyCiProfile,
  type PreparedCiWorkflow } from './helpers/crossComputerCiSetup.js'
import { createScenarioObservation, pollCiScenario, verifyCiScenario, verifyExcludedComputers,
  type RunningCiWorkflow } from './helpers/crossComputerCiObservation.js'

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
  const tools = await listCiToolNames(client)
  expect(tools).toEqual(expect.arrayContaining([
    'ci_run', 'ci_get', 'ci_computers_list', 'ci_logs_read', 'ci_artifacts_list', 'ci_artifact_read', 'ci_cancel',
    'job_queue_list', 'job_launch_validate', 'run_start', 'run_stop', 'run_get', 'run_executions_list',
    'run_activities_get_v1', 'workflow_node_placement_choices', 'harness_instance_save', 'harness_instance_check',
  ]))
  const checked = new Set<string>()
  for (const workspace of input.workspaces) {
    for (const computer of workspace.computers) {
      const identity = JSON.stringify(computer.hostRef)
      if (checked.has(identity)) continue
      const inventory = HarnessRegistryReadbackSchema.parse(await callCiTool(client, 'harness_registry_get', computer.hostRef))
      if (computer.hostRef.kind === 'device' && inventory.hostMetadata?.connection?.phase !== 'ready') {
        throw new Error(`${computer.name} must be online before starting the scenario with that Agent computer.`)
      }
      checked.add(identity)
    }
  }
  for (const workspace of input.workspaces) {
    const choices = JobAuthoringChoicesRecordSchema.parse(await callCiTool(client, 'ci_computers_list', {
      workspaceId: workspace.workspaceId,
    }))
    for (const suite of projectSuites[workspace.project]) {
      expect(choices.verificationTemplates?.some(template => template.suite === suite && template.ready),
        `${workspace.project} needs a qualified ${suite} profile`).toBe(true)
    }
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
      placementOverride: { kind: 'auto' },
    })
  }
  const starts = await Promise.allSettled(requests.map(async ({ workflow, request }) => {
    const result = ManualRunStartResultSchema.parse(await callCiTool(client, 'run_start', request))
    running.push({ ...workflow, runId: result.run.id })
  }))
  const rejected = starts.find(result => result.status === 'rejected')
  if (rejected?.status === 'rejected') throw rejected.reason
}

async function verifyWorkspaceIsolation(client: Client, running: RunningCiWorkflow[],
  observation: ReturnType<typeof createScenarioObservation>) {
  for (const workflow of running) {
    const foreign = running.find(value => value.workspace.workspaceId !== workflow.workspace.workspaceId)!
    const result = await client.callTool({ name: 'run_get', arguments: {
      workspaceId: foreign.workspace.workspaceId, runId: workflow.runId,
    } }, { timeout: 30_000 })
    expect(result.isError, 'A Run cannot be read through another workspace').toBe(true)
    expect(decodeMcpToolResult(result)).not.toHaveProperty('run')
    const tickets = [...observation.tickets.values()].filter(ticket => ticket.runId === workflow.runId)
    for (const ticket of tickets) {
      for (const name of ['ci_get', 'ci_logs_read', 'ci_artifacts_list']) {
        const otherWorkspace = await client.callTool({ name, arguments: {
          workspaceId: foreign.workspace.workspaceId, ticketId: ticket.ticketId,
        } }, { timeout: 30_000 })
        expect(otherWorkspace.isError, `${name} must preserve the ticket workspace`).toBe(true)
        for (const field of ['queue', 'chunks', 'artifacts']) {
          expect(decodeMcpToolResult(otherWorkspace)).not.toHaveProperty(field)
        }
      }
    }
  }
}

async function cleanupFailedRuns(client: Client, workflows: RunningCiWorkflow[]): Promise<string[]> {
  const errors: string[] = []
  for (const workflow of workflows) {
    try {
      const scope = { workspaceId: workflow.workspace.workspaceId, runId: workflow.runId }
      await callCiTool(client, 'run_stop', { ...scope, commandId: randomUUID() })
      let details = SavedRunDetailsSchema.parse(await callCiTool(client, 'run_get', { ...scope, detail: 'full' }))
      const stopDeadline = Date.now() + 120_000
      while ((details.run.executionState !== 'completed' || details.cleanupPending) && Date.now() < stopDeadline) {
        await delay(1000)
        details = SavedRunDetailsSchema.parse(await callCiTool(client, 'run_get', { ...scope, detail: 'full' }))
      }
      if (details.run.executionState !== 'completed' || details.cleanupPending) {
        errors.push(`Run ${workflow.runId} has not confirmed cleanup.`)
      }
      for (const execution of details.executions) {
        const queue = JobQueuePageSchema.parse(await callCiTool(client, 'job_queue_list', {
          workspaceId: scope.workspaceId, initiatingExecutionId: execution.id,
        }))
        for (const ticket of queue.tickets) {
          if (ticket.state === 'terminal') continue
          await callCiTool(client, 'ci_cancel', {
            workspaceId: scope.workspaceId, ticketId: ticket.id,
            expectedRevision: ticket.revision, commandId: randomUUID(),
          })
          const deadline = Date.now() + 120_000
          let closed = false
          while (Date.now() < deadline) {
            const ci = CiGetOutputSchema.parse(await callCiTool(client, 'ci_get', {
              workspaceId: scope.workspaceId, ticketId: ticket.id,
            }))
            closed = ci.queue.state === 'terminal' && (!ci.process || ci.process.processStopped)
            if (closed) break
            await delay(1000)
          }
          if (!closed) errors.push(`Ticket ${ticket.id} has not confirmed process closure.`)
        }
      }
    } catch (error) {
      errors.push(`Run ${workflow.runId} cleanup: ${error instanceof Error ? error.message : 'failed'}`)
    }
  }
  return errors
}

it('runs concurrent cross-computer CI with isolated workflow readback twice in a row', async () => {
  const input = await readCrossComputerCiInput()
  await mkdir(input.evidenceDirectory, { recursive: true, mode: 0o700 })
  const evidencePath = join(input.evidenceDirectory, `cross-computer-ci-${Date.now()}.json`)
  const rounds: {
    round: number
    status: 'running' | 'passed' | 'failed'
    workflows: RunningCiWorkflow[]
    observation: ReturnType<typeof createScenarioObservation>
  }[] = []
  const evidence = { startedAt: new Date().toISOString(), finishedAt: null as string | null,
    passed: false, failure: null as string | null, cleanupErrors: [] as string[] }
  const redact = (text: string) => text.replaceAll(input.token, '[redacted]').replaceAll(input.deniedToken, '[redacted]')
  const persist = async () => {
    const content = { ...evidence, rounds: rounds.map(round => ({
      round: round.round, status: round.status,
      workflows: round.workflows.map(workflow => ({ workspaceId: workflow.workspace.workspaceId,
        workflowId: workflow.graph.id, runId: workflow.runId, project: workflow.workspace.project,
        assignments: workflow.assignments.map(agent => ({ agentId: agent.agentId, nodeId: agent.nodeId,
          suite: agent.suite, hostRef: agent.profile.target.hostRef })) })),
      tickets: [...round.observation.tickets.values()],
      runs: [...round.observation.runs.values()],
      agentStates: Object.fromEntries(round.observation.agentStates),
      activities: Object.fromEntries([...round.observation.activities].map(([runId, items]) => [runId, [...items.values()]])),
      exclusions: round.observation.exclusions,
      exclusionCoverage: input.excludedComputers.length ? 'configured' : 'not_requested',
    })) }
    await writeFile(evidencePath, redact(JSON.stringify(content, null, 2)), { mode: 0o600 })
  }
  const writer = await connectCiOperator(input.endpoint, input.token)
  let denied: Client | undefined
  try {
    denied = await connectCiOperator(input.endpoint, input.deniedToken)
    await verifyPrerequisites(writer, input)
    const profiles = await prepareProfiles(writer, input)
    for (const round of [1, 2]) {
      const state = { round, status: 'running' as const, workflows: [] as RunningCiWorkflow[],
        observation: createScenarioObservation() }
      rounds.push(state)
      const prepared: PreparedCiWorkflow[] = []
      for (const workspace of input.workspaces) prepared.push(await prepareCiWorkflow(writer, workspace, profiles, round))
      await startWorkflows(writer, denied, prepared, state.workflows)
      await persist()
      await pollCiScenario(writer, state.workflows, state.observation, persist, input)
      await verifyCiScenario(writer, state.workflows, state.observation)
      await verifyExcludedComputers(writer, input, state.observation)
      await verifyWorkspaceIsolation(writer, state.workflows, state.observation)
      rounds[round - 1]!.status = 'passed'
      await persist()
    }
    evidence.passed = true
  } catch (error) {
    evidence.failure = redact(error instanceof Error ? error.message : 'Scenario failed.')
    for (const round of rounds) {
      if (round.status === 'running') round.status = 'failed'
      evidence.cleanupErrors.push(...await cleanupFailedRuns(writer, round.workflows))
    }
    throw error
  } finally {
    evidence.finishedAt = new Date().toISOString()
    const closed = await Promise.allSettled([denied?.close(), writer.close()])
    for (const result of closed) {
      if (result.status === 'rejected') {
        evidence.cleanupErrors.push('Failed to close a scenario MCP client.')
        evidence.passed = false
      }
    }
    await persist()
  }
  expect(evidence.cleanupErrors).toEqual([])
}, 9 * 60 * 60_000)
