import { setTimeout as delay } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import type { Client } from '@modelcontextprotocol/client'
import { expect } from 'vitest'
import { z } from 'zod'
import { CiGetOutputSchema, CiLogsOutputSchema, CiArtifactsOutputSchema } from '@foreman-code/contracts'
import { JobQueuePageSchema, JobLaunchValidationSchema } from '@foreman-code/contracts/job-admission'
import { HarnessHostReferenceSchema } from '@foreman-code/contracts/harness-registry'
import { RunPlacementGetResultSchema } from '@foreman-code/contracts/placement-readback'
import { SavedRunDetailsSchema, RunExecutionsPageSchema, RunActivitiesPageSchema,
  type SavedRunDetails, type RunActivityPublic } from '@foreman-code/contracts/wave25'
import type { CrossComputerCiInput } from './crossComputerCiInput.js'
import { callCiTool, type PreparedCiWorkflow } from './crossComputerCiSetup.js'
import { requireCiWorkflowActivity } from './crossComputerCiActivity.js'

type CiReadback = z.infer<typeof CiGetOutputSchema>
export type RunningCiWorkflow = PreparedCiWorkflow & { runId: string }
type TicketSample = {
  observedAt: string
  executionId: string | null
  queueState: CiReadback['queue']['state']
  processPhase: NonNullable<CiReadback['process']>['phase'] | null
  publication: CiReadback['publication']
  waitingReasons: string[]
  computer: CiReadback['queue']['selectedComputer']
  logTail: string
}
export type TicketObservation = {
  ticketId: string
  workspaceId: string
  workflowId: string
  runId: string
  agentId: string
  initiatingExecutionId: string
  enqueuedAt: string
  timeline: TicketSample[]
  latest: CiReadback
}
export type ScenarioObservation = {
  tickets: Map<string, TicketObservation>
  runs: Map<string, SavedRunDetails>
  agentStates: Map<string, { observedAt: string; state: string }[]>
  activities: Map<string, Map<string, RunActivityPublic>>
  activityCursors: Map<string, string>
  exclusions: { workspaceId: string; target: unknown; reasons: string[]; observedAt: string }[]
}
export function createScenarioObservation(): ScenarioObservation {
  return { tickets: new Map(), runs: new Map(), agentStates: new Map(), activities: new Map(),
    activityCursors: new Map(), exclusions: [] }
}

async function captureWorkflowActivity(client: Client, workflow: RunningCiWorkflow, observation: ScenarioObservation) {
  const items = observation.activities.get(workflow.runId) ?? new Map<string, RunActivityPublic>()
  let cursor = observation.activityCursors.get(workflow.runId)
  let nextCursor = cursor
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const page = RunActivitiesPageSchema.parse(await callCiTool(client, 'run_activities_get_v1', {
      workspaceId: workflow.workspace.workspaceId, runId: workflow.runId, limit: 100, ...(cursor ? { cursor } : {}),
    }))
    expect(page.scope.workflowId).toBe(workflow.graph.id)
    for (const item of page.items) items.set(item.id, item)
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

async function observeTicket(client: Client, workflow: RunningCiWorkflow,
  ticket: z.infer<typeof JobQueuePageSchema>['tickets'][number], observation: ScenarioObservation) {
  const ci = CiGetOutputSchema.parse(await callCiTool(client, 'ci_get', {
    workspaceId: workflow.workspace.workspaceId, ticketId: ticket.id,
  }))
  expect(ci.queue.id).toBe(ticket.id)
  expect(ci.queue.workspaceId).toBe(workflow.workspace.workspaceId)
  expect(ci.queue.initiatingAgent).toEqual(ticket.initiatingAgent)
  expect(ci.queue.placement).toEqual({ kind: 'auto' })
  const origin = ticket.initiatingAgent!
  const observed = observation.tickets.get(ticket.id) ?? {
    ticketId: ticket.id, workspaceId: ticket.workspaceId, workflowId: workflow.graph.id,
    runId: workflow.runId, agentId: origin.agentId, initiatingExecutionId: origin.executionId,
    enqueuedAt: ticket.enqueuedAt, timeline: [], latest: ci,
  }
  const sample: TicketSample = {
    observedAt: new Date().toISOString(), executionId: ci.executionId, queueState: ci.queue.state,
    processPhase: ci.process?.phase ?? null, publication: ci.publication,
    waitingReasons: ci.queue.waitingReasons, computer: ci.queue.selectedComputer,
    logTail: ci.logTail.text.slice(-2048),
  }
  const previous = observed.timeline.at(-1)
  if (!previous || previous.queueState !== sample.queueState || previous.processPhase !== sample.processPhase
    || previous.publication !== sample.publication || !isDeepStrictEqual(previous.waitingReasons, sample.waitingReasons)) {
    observed.timeline.push(sample)
  }
  observed.latest = ci
  observation.tickets.set(ticket.id, observed)
}

async function observeWorkflow(client: Client, workflow: RunningCiWorkflow, observation: ScenarioObservation) {
  const details = SavedRunDetailsSchema.parse(await callCiTool(client, 'run_get', {
    workspaceId: workflow.workspace.workspaceId, runId: workflow.runId,
  }))
  expect(details.run.workflowId).toBe(workflow.graph.id)
  observation.runs.set(workflow.runId, details)
  for (const execution of details.executions) {
    const assignment = workflow.assignments.find(agent => agent.agentId === execution.agentId)
    expect(assignment, 'Run contains only this workflow’s Agents').toBeDefined()
    const states = observation.agentStates.get(execution.id) ?? []
    if (states.at(-1)?.state !== execution.state) states.push({ observedAt: new Date().toISOString(), state: execution.state })
    observation.agentStates.set(execution.id, states)
    const queued = JobQueuePageSchema.parse(await callCiTool(client, 'job_queue_list', {
      workspaceId: workflow.workspace.workspaceId, initiatingExecutionId: execution.id,
    }))
    expect(queued.nextHistoryCursor, 'One Agent’s ticket history must be complete').toBeNull()
    expect(queued.tickets.length).toBeLessThanOrEqual(assignment!.suite === null ? 0 : 1)
    for (const ticket of queued.tickets) {
      expect(ticket.workspaceId).toBe(workflow.workspace.workspaceId)
      expect(ticket.initiatingAgent).toEqual({
        workflowId: workflow.graph.id, runId: workflow.runId, agentId: execution.agentId, executionId: execution.id,
      })
      expect(ticket.definition.schemaVersion).toBe(2)
      if (ticket.definition.schemaVersion === 2) expect(ticket.definition.spec.verification.suite).toBe(assignment!.suite)
      await observeTicket(client, workflow, ticket, observation)
    }
  }
  await captureWorkflowActivity(client, workflow, observation)
}

export async function pollCiScenario(client: Client, workflows: RunningCiWorkflow[],
  observation: ScenarioObservation, persist: () => Promise<void>, input: CrossComputerCiInput) {
  const deadline = Date.now() + 90 * 60_000
  const expectedTickets = workflows.reduce((count, workflow) =>
    count + workflow.assignments.filter(agent => agent.suite !== null).length, 0)
  let nextCheckpoint = 0
  while (Date.now() < deadline) {
    await Promise.all(workflows.map(workflow => observeWorkflow(client, workflow, observation)))
    const canCheckExclusions = input.excludedComputers.every(excluded =>
      [...observation.tickets.values()].some(ticket => ticket.workspaceId === excluded.workspaceId))
    if (input.excludedComputers.length && !observation.exclusions.length && canCheckExclusions) {
      await verifyExcludedComputers(client, input, observation)
    }
    if (Date.now() >= nextCheckpoint) {
      await persist()
      nextCheckpoint = Date.now() + 30_000
    }
    const failed = [...observation.runs.values()].find(details => details.run.outcome === 'failed'
      || details.run.outcome === 'canceled' || details.executions.some(execution => execution.result?.outcome === 'failed'))
    if (failed) throw new Error(`CI workflow ${failed.run.id} failed; inspect the private scenario evidence.`)
    const runsFinished = workflows.every(workflow => observation.runs.get(workflow.runId)?.run.executionState === 'completed')
    const ticketsFinished = observation.tickets.size === expectedTickets && [...observation.tickets.values()].every(ticket =>
      ticket.latest.queue.state === 'terminal' && ticket.latest.process?.phase === 'terminal'
      && ticket.latest.publication === 'complete')
    if (runsFinished && ticketsFinished) return
    await delay(1000)
  }
  throw new Error('Cross-computer CI exceeded its 90-minute round deadline.')
}

const AgentReportSchema = z.object({
  ticketId: z.string().min(1), executionId: z.string().min(1),
  suite: z.enum(['build', 'lint', 'integration', 'unit']), computer: HarnessHostReferenceSchema,
  outcome: z.literal('succeeded'), repository: z.string().min(1), branch: z.string().min(1),
  logLine: z.string().trim().min(1), summarySha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()

function readAgentReport(output: unknown) {
  const text = z.object({ text: z.string() }).safeParse(output)
  const raw = text.success ? text.data.text : output
  return AgentReportSchema.parse(typeof raw === 'string' ? JSON.parse(raw) : raw)
}

async function verifyTicketReport(client: Client, ticket: TicketObservation, output: unknown) {
  const ci = ticket.latest
  const report = readAgentReport(output)
  expect(report.ticketId).toBe(ticket.ticketId)
  expect(report.executionId).toBe(ci.executionId)
  expect(report.computer).toEqual(ci.queue.selectedComputer?.target.hostRef)
  expect(ci.process).toMatchObject({ phase: 'terminal', outcome: 'succeeded', processStopped: true })
  expect(ci.publication).toBe('complete')
  expect(ci.resultIssue).toBeNull()
  expect(ci.queue.state).toBe('terminal')
  expect(ci.queue.terminalReason).toBe('completed')
  expect(ci.summaryReport?.report).toMatchObject({
    suite: report.suite, outcome: 'passed', completeness: 'complete', firstPassFailed: 0, disallowedSkipped: 0,
  })
  expect(ci.summaryReport?.report.executionId).toBe(report.executionId)
  expect(ticket.timeline.some(sample => sample.processPhase === 'running'), 'Observe each CI process running').toBe(true)
  expect(ticket.timeline.at(-1)?.processPhase).toBe('terminal')
  const scope = { workspaceId: ticket.workspaceId, ticketId: ticket.ticketId }
  const artifacts = CiArtifactsOutputSchema.parse(await callCiTool(client, 'ci_artifacts_list', scope)).artifacts
  expect(artifacts.length).toBeGreaterThan(0)
  expect(artifacts.every(artifact => artifact.executionId === ci.executionId)).toBe(true)
  expect(artifacts.some(artifact => artifact.path.endsWith('/summary.json') && artifact.sha256 === report.summarySha256)).toBe(true)
  let cursor = 0
  let foundLine = ci.logTail.text.split('\n').some(line => line.trim() === report.logLine)
  for (let pageNumber = 0; pageNumber < 1000; pageNumber++) {
    const page = CiLogsOutputSchema.parse(await callCiTool(client, 'ci_logs_read', { ...scope, afterSequence: cursor, limit: 100 }))
    expect(page.chunks.every(chunk => chunk.executionId === ci.executionId && chunk.attemptId === ci.queue.attemptId)).toBe(true)
    foundLine ||= page.chunks.some(chunk => chunk.text.split('\n').some(line => line.trim() === report.logLine))
    if (page.nextCursor === cursor) break
    cursor = page.nextCursor
    if (pageNumber === 999) throw new Error('CI log verification exceeded its bounded pagination budget.')
  }
  expect(foundLine, 'Agent reports a line from its own CI execution').toBe(true)
  return report
}

async function verifyWorkflow(client: Client, workflow: RunningCiWorkflow, observation: ScenarioObservation) {
  const scope = { workspaceId: workflow.workspace.workspaceId, runId: workflow.runId }
  const details = SavedRunDetailsSchema.parse(await callCiTool(client, 'run_get', scope))
  expect(details.run.outcome).toBe('succeeded')
  expect(details.executions).toHaveLength(workflow.assignments.length)
  const executions = RunExecutionsPageSchema.parse(await callCiTool(client, 'run_executions_list', { ...scope, limit: 100 }))
  expect(executions.pageInfo.nextCursor).toBeNull()
  const branches: string[] = []
  const directories: string[] = []
  for (const assignment of workflow.assignments) {
    const execution = details.executions.find(value => value.agentId === assignment.agentId)!
    expect(execution.result?.outcome).toBe('succeeded')
    expect(observation.agentStates.get(execution.id)?.some(state => state.state !== 'completed')).toBe(true)
    const worktree = executions.items.find(value => value.executionId === execution.id)?.worktree
    expect(worktree?.repository).toBe(workflow.repository)
    expect(worktree?.branch).toBeTruthy()
    expect(execution.workingDirectory).toBeTruthy()
    branches.push(worktree!.branch)
    directories.push(`${JSON.stringify(assignment.profile.target.hostRef)}:${execution.workingDirectory!}`)
    const placement = RunPlacementGetResultSchema.parse(await callCiTool(client, 'run_node_placement_get', {
      ...scope, workflowId: workflow.graph.id, nodeId: assignment.nodeId,
    })).readback
    expect(placement.evidence).toBe('accepted')
    if (placement.evidence === 'accepted') expect(placement.placement.hostRef).toEqual(assignment.profile.target.hostRef)
    if (assignment.suite === null) continue
    const tickets = [...observation.tickets.values()].filter(ticket => ticket.initiatingExecutionId === execution.id)
    expect(tickets).toHaveLength(1)
    const report = await verifyTicketReport(client, tickets[0]!, execution.result?.output)
    expect(report.suite).toBe(assignment.suite)
    expect(report.repository).toBe(worktree!.repository)
    expect(report.branch).toBe(worktree!.branch)
  }
  expect(new Set(branches).size).toBe(branches.length)
  expect(new Set(directories).size).toBe(directories.length)
  await verifyWorkflowActivity(client, workflow, observation)
}

async function verifyWorkflowActivity(client: Client, workflow: RunningCiWorkflow, observation: ScenarioObservation) {
  await captureWorkflowActivity(client, workflow, observation)
  const ownTickets = [...observation.tickets.values()].filter(ticket => ticket.runId === workflow.runId)
  const foreignTickets = [...observation.tickets.values()].filter(ticket => ticket.runId !== workflow.runId)
  const jobIds = new Set(ownTickets.map(ticket => ticket.latest.executionId))
  const agentIds = new Set(observation.runs.get(workflow.runId)!.executions.map(execution => execution.id))
  const items = [...observation.activities.get(workflow.runId)!.values()]
  for (const item of items) {
    if (item.refs.executionId) expect(agentIds.has(item.refs.executionId)).toBe(true)
    if (item.refs.jobExecutionId) expect(jobIds.has(item.refs.jobExecutionId)).toBe(true)
  }
  const text = JSON.stringify(items)
  for (const ticket of foreignTickets) expect(text).not.toContain(ticket.ticketId)
  requireCiWorkflowActivity(items, { runId: workflow.runId, agentExecutionIds: [...agentIds],
    jobExecutionIds: ownTickets.map(ticket => ticket.latest.executionId!) })
}

export async function verifyCiScenario(client: Client, workflows: RunningCiWorkflow[], observation: ScenarioObservation) {
  const expectedCount = workflows.reduce((count, workflow) => count + workflow.assignments.filter(agent => agent.suite).length, 0)
  expect(observation.tickets.size, 'No lost or duplicated CI tickets').toBe(expectedCount)
  expect(new Set([...observation.tickets.values()].map(ticket => ticket.latest.executionId)).size).toBe(expectedCount)
  for (const workflow of workflows) await verifyWorkflow(client, workflow, observation)
  const computers = new Set([...observation.tickets.values()].map(ticket => JSON.stringify(ticket.latest.queue.selectedComputer?.target.hostRef)))
  expect(computers.size, 'At least two computers execute CI').toBeGreaterThanOrEqual(2)
  expect([...observation.tickets.values()].some(ticket => ticket.timeline.some(sample =>
    ['waiting', 'blocked'].includes(sample.queueState) && sample.waitingReasons.includes('busy'))),
  'Observe a real ticket waiting for occupied build capacity').toBe(true)
  const intervals = [...observation.tickets.values()].map(ticket => ({
    workflowId: ticket.workflowId, start: Date.parse(ticket.enqueuedAt),
    end: Date.parse(ticket.latest.queue.finishedAt!),
  }))
  expect(intervals.some(first => intervals.some(second => first.workflowId !== second.workflowId
    && first.start < second.end && second.start < first.end)), 'CI from different workflows overlaps').toBe(true)
}

export async function verifyExcludedComputers(client: Client, input: CrossComputerCiInput, observation: ScenarioObservation) {
  for (const excluded of input.excludedComputers) {
    const ticket = [...observation.tickets.values()].find(value => value.workspaceId === excluded.workspaceId)!
    const definition = ticket.latest.queue.definition
    const validation = JobLaunchValidationSchema.parse(await callCiTool(client, 'job_launch_validate', {
      workspaceId: excluded.workspaceId, definitionId: definition.id, expectedRevision: definition.revision,
      placementOverride: { kind: 'explicit', target: excluded.target },
    }))
    expect(validation.valid).toBe(false)
    const reasonPattern = excluded.reason === 'offline' ? /offline|not_connected/i : /refus|root|source|denied|revoked/i
    expect(validation.reasons.some(reason => reasonPattern.test(reason)), 'The supplied excluded root has a live reason').toBe(true)
    observation.exclusions.push({ workspaceId: excluded.workspaceId, target: excluded.target,
      reasons: validation.reasons, observedAt: new Date().toISOString() })
    for (const observed of observation.tickets.values()) {
      if (observed.workspaceId !== excluded.workspaceId) continue
      const target = observed.latest.queue.selectedComputer?.target
      expect(target && isDeepStrictEqual(target.hostRef, excluded.target.hostRef)
        && target.destination.rootPolicyId === excluded.target.destination.rootPolicyId
        && target.destination.rootPolicyRevision === excluded.target.destination.rootPolicyRevision
        && target.destination.locationRevision === excluded.target.destination.locationRevision).toBe(false)
    }
  }
}
