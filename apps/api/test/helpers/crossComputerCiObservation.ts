import { setTimeout as delay } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import type { Client } from '@modelcontextprotocol/client'
import { CiComputersOutputSchema, CiGetOutputSchema, type CiRunRecord } from '@foreman-code/contracts'
import { RunEventsPageSchema } from '@foreman-code/contracts/management'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { RunActivitiesPageSchema, SavedRunDetailsSchema,
  type RunActivityPublic, type SavedRunDetails } from '@foreman-code/contracts/wave25'
import { expect } from 'vitest'
import { z } from 'zod'
import { callCiTool, callCiToolResult, toolErrorCode, type PreparedCiWorkflow } from './crossComputerCiSetup.js'
import { ciTerminal, readAgentCiReport, type AgentCiReport, type CiReadback } from './crossComputerCiReadback.js'

export type RunningCiWorkflow = PreparedCiWorkflow & { runId: string }
export type TicketObservation = {
  ticketId: string
  workspaceId: string
  workflowId: string
  runId: string
  agentId: string
  initiatingExecutionId: string
  timeline: { observedAt: string; run: CiRunRecord }[]
  latest: CiRunRecord
  log?: { text: string; logBytes: number }
}
export function createScenarioObservation() {
  return {
    tickets: new Map<string, TicketObservation>(),
    groups: new Map<string, CiReadback>(),
    runs: new Map<string, SavedRunDetails>(),
    reports: new Map<string, AgentCiReport>(),
    agentStates: new Map<string, { observedAt: string; state: string }[]>(),
    activities: new Map<string, Map<string, RunActivityPublic>>(),
    activityCursors: new Map<string, string>(),
    eventSequences: new Map<string, number>(),
    candidates: new Map<string, Set<string>>(),
    queueWitness: null as { observedAt: string; queued: string[]; active: string[] } | null,
    concurrencyWitness: null as { observedAt: string; groupIds: string[] } | null,
    exclusions: [] as { workspaceId: string; hostRef: unknown; observedAt: string; reasons: string[] }[],
  }
}
export type ScenarioObservation = ReturnType<typeof createScenarioObservation>

function candidate(observation: ScenarioObservation, runId: string, ticketId: string) {
  const ids = observation.candidates.get(runId) ?? new Set<string>()
  ids.add(ticketId)
  observation.candidates.set(runId, ids)
}

async function captureWorkflowActivity(client: Client, workflow: RunningCiWorkflow, observation: ScenarioObservation) {
  const items = observation.activities.get(workflow.runId) ?? new Map<string, RunActivityPublic>()
  let cursor = observation.activityCursors.get(workflow.runId)
  let nextCursor = cursor
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const page = RunActivitiesPageSchema.parse(await callCiTool(client, 'run_activities_get_v1', {
      workspaceId: workflow.workspace.workspaceId, runId: workflow.runId, limit: 100,
      ...(cursor ? { cursor } : {}),
    }))
    expect(page.scope.workflowId).toBe(workflow.graph.id)
    expect(page.scope.workflowVersionId).toBe(workflow.saved.version.id)
    for (const item of page.items) {
      items.set(item.id, item)
      if (item.kind === 'job_work' && item.refs.jobExecutionId) {
        candidate(observation, workflow.runId, item.refs.jobExecutionId)
      }
    }
    observation.activities.set(workflow.runId, items)
    if (page.mode !== 'older') nextCursor = page.nextCursor
    const follow = page.mode === 'newer' && page.hasMore ? page.nextCursor : page.olderCursor
    if (!follow) {
      observation.activityCursors.set(workflow.runId, nextCursor!)
      return
    }
    cursor = follow
  }
  throw new Error('Run activity collection exceeded its bounded pagination budget.')
}

async function discoverActivityTickets(client: Client, workflow: RunningCiWorkflow, observation: ScenarioObservation) {
  let afterSequence = observation.eventSequences.get(workflow.runId)
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const page = RunEventsPageSchema.parse(await callCiTool(client, 'run_events_list', {
      workspaceId: workflow.workspace.workspaceId, runId: workflow.runId, limit: 500,
      ...(afterSequence === undefined ? {} : { afterSequence }),
    }))
    for (const event of page.items) {
      expect(event.runId).toBe(workflow.runId)
      if (event.kind === 'ci_state_changed') {
        const ticket = z.object({ ticketId: CiGetOutputSchema.shape.run.shape.id }).parse(event.payload)
        candidate(observation, workflow.runId, ticket.ticketId)
      }
      afterSequence = event.sequence
    }
    if (afterSequence !== undefined) observation.eventSequences.set(workflow.runId, afterSequence)
    if (!page.pageInfo.nextCursor) return
  }
  throw new Error('Run event collection exceeded its bounded pagination budget.')
}

function recordCiGroup(workflow: RunningCiWorkflow, readback: CiReadback, observation: ScenarioObservation) {
  const details = observation.runs.get(workflow.runId)!
  const execution = details.executions.find(item => item.id === readback.run.initiator.executionId)
  expect(execution, 'CI belongs to an execution in this workflow').toBeDefined()
  const assignment = workflow.assignments.find(item => item.agentId === execution!.agentId)!
  expect(assignment.suite, 'A coordinator must not request CI').not.toBeNull()
  const previousGroup = observation.groups.get(execution!.id)
  if (previousGroup) {
    expect(readback.run.groupId, 'One CI request per Agent').toBe(previousGroup.run.groupId)
    const previousIds = (previousGroup.partitions ?? [previousGroup.run]).map(run => run.id).sort()
    expect((readback.partitions ?? [readback.run]).map(run => run.id).sort(), 'A CI group retains all its tickets')
      .toEqual(previousIds)
  }
  const runs = readback.partitions ?? [readback.run]
  expect(runs.some(run => run.id === readback.run.id)).toBe(true)
  expect(new Set(runs.map(run => run.id)).size).toBe(runs.length)
  for (const run of runs) {
    expect(run).toMatchObject({
      workspaceId: workflow.workspace.workspaceId, suite: assignment.suite, repository: workflow.repository,
      groupId: readback.run.groupId, scope: 'full', files: [], initiator: readback.run.initiator,
    })
    expect(run.commit).toBe(readback.run.commit)
    const observed: TicketObservation = observation.tickets.get(run.id) ?? {
      ticketId: run.id, workspaceId: run.workspaceId, workflowId: workflow.graph.id, runId: workflow.runId,
      agentId: execution!.agentId, initiatingExecutionId: execution!.id, timeline: [], latest: run,
    }
    expect(observed.runId).toBe(workflow.runId)
    if (!isDeepStrictEqual(observed.latest, run) || !observed.timeline.length) {
      observed.timeline.push({ observedAt: new Date().toISOString(), run })
    }
    observed.latest = run
    observation.tickets.set(run.id, observed)
  }
  observation.groups.set(execution!.id, readback)
}

async function observeWorkflow(client: Client, workflow: RunningCiWorkflow, observation: ScenarioObservation) {
  const details = SavedRunDetailsSchema.parse(await callCiTool(client, 'run_get', {
    workspaceId: workflow.workspace.workspaceId, runId: workflow.runId, detail: 'full',
  }))
  expect(details.run.workflowId).toBe(workflow.graph.id)
  expect(details.run.workflowVersionId).toBe(workflow.saved.version.id)
  observation.runs.set(workflow.runId, details)
  for (const execution of details.executions) {
    const assignment = workflow.assignments.find(agent => agent.agentId === execution.agentId)
    expect(assignment, 'Run contains only this workflow’s Agents').toBeDefined()
    const states = observation.agentStates.get(execution.id) ?? []
    if (states.at(-1)?.state !== execution.state) {
      states.push({ observedAt: new Date().toISOString(), state: execution.state })
    }
    observation.agentStates.set(execution.id, states)
    if (assignment!.suite && execution.result?.outcome === 'succeeded') {
      const report = readAgentCiReport(execution.result.output)
      observation.reports.set(execution.id, report)
      candidate(observation, workflow.runId, report.ticketId)
    }
  }
  await captureWorkflowActivity(client, workflow, observation)
  await discoverActivityTickets(client, workflow, observation)
  const inventory = CiComputersOutputSchema.parse(await callCiTool(client, 'ci_computers_list', {
    workspaceId: workflow.workspace.workspaceId,
  }))
  const ids = new Set(observation.candidates.get(workflow.runId))
  for (const ticket of observation.tickets.values()) {
    if (ticket.runId === workflow.runId) ids.add(ticket.ticketId)
  }
  for (const computer of inventory.computers) {
    for (const id of computer.running ?? []) ids.add(id)
  }
  const groups = new Set<string>()
  for (const ticketId of ids) {
    const known = observation.tickets.get(ticketId)
    if (known && groups.has(known.latest.groupId)) continue
    const result = await callCiToolResult(client, 'ci_get', {
      workspaceId: workflow.workspace.workspaceId, ticketId,
    })
    // Computer inventory includes other workspaces; a scoped CI read must reject those IDs.
    if (result.isError && toolErrorCode(result) === 'CI_RUN_NOT_FOUND') {
      expect(observation.candidates.get(workflow.runId)?.has(ticketId)).not.toBe(true)
      continue
    }
    expect(result.isError, 'Read a discovered Host CI ticket').not.toBe(true)
    const readback = CiGetOutputSchema.parse(decodeMcpToolResult(result))
    if (!details.executions.some(execution => execution.id === readback.run.initiator.executionId)) {
      expect(observation.candidates.get(workflow.runId)?.has(ticketId), 'Run activity exposes only its own CI').not.toBe(true)
      continue
    }
    recordCiGroup(workflow, readback, observation)
    candidate(observation, workflow.runId, ticketId)
    groups.add(readback.run.groupId)
  }
}

export async function pollCiScenario(client: Client, workflows: RunningCiWorkflow[],
  observation: ScenarioObservation, persist: () => Promise<void>) {
  const deadline = Date.now() + 4 * 60 * 60_000
  const expectedRequests = workflows.reduce((count, workflow) =>
    count + workflow.assignments.filter(agent => agent.suite).length, 0)
  let nextCheckpoint = 0
  while (Date.now() < deadline) {
    const results = await Promise.allSettled(workflows.map(workflow => observeWorkflow(client, workflow, observation)))
    const rejected = results.find(result => result.status === 'rejected')
    if (rejected?.status === 'rejected') throw rejected.reason
    const tickets = [...observation.tickets.values()]
    const queued = tickets.filter(ticket => ticket.latest.state === 'queued').map(ticket => ticket.ticketId)
    const active = tickets.filter(ticket => ['starting', 'running'].includes(ticket.latest.state))
      .map(ticket => ticket.ticketId)
    if (!observation.queueWitness && queued.length && active.length) {
      observation.queueWitness = { observedAt: new Date().toISOString(), queued, active }
    }
    const groups = [...observation.groups.values()]
    if (!observation.concurrencyWitness && groups.length === expectedRequests
      && groups.every(group => (group.partitions ?? [group.run]).some(run => !ciTerminal(run.state)))) {
      observation.concurrencyWitness = { observedAt: new Date().toISOString(), groupIds: groups.map(group => group.run.groupId) }
    }
    if (Date.now() >= nextCheckpoint) {
      await persist()
      nextCheckpoint = Date.now() + 30_000
    }
    const failed = [...observation.runs.values()].find(details => ['failed', 'canceled'].includes(details.run.outcome))
    if (failed) throw new Error(`CI workflow ${failed.run.id} failed; inspect the private round evidence.`)
    const runsFinished = workflows.every(workflow => {
      const details = observation.runs.get(workflow.runId)
      return details?.run.executionState === 'completed' && !details.cleanupPending
    })
    const ticketsFinished = observation.groups.size === expectedRequests
      && [...observation.tickets.values()].every(ticket => ciTerminal(ticket.latest.state))
    if (runsFinished && ticketsFinished) return
    if (runsFinished) throw new Error('Completed workflows did not report all of their CI requests.')
    await delay(1000)
  }
  throw new Error('Cross-computer CI exceeded its four-hour round deadline.')
}
