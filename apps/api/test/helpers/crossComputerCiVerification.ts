import type { Client } from '@modelcontextprotocol/client'
import { CiGetOutputSchema, CiLogsOutputSchema } from '@foreman-code/contracts'
import { RunExecutionsPageSchema } from '@foreman-code/contracts/wave25'
import { RunPlacementGetResultSchema } from '@foreman-code/contracts/placement-readback'
import { expect } from 'vitest'
import { callCiTool } from './crossComputerCiSetup.js'
import { readCiLog, requireCiStateOrder } from './crossComputerCiReadback.js'
import { requireCiWorkflowActivity } from './crossComputerCiActivity.js'
import type { CrossComputerCiInput } from './crossComputerCiInput.js'
import type { RunningCiWorkflow, ScenarioObservation, TicketObservation } from './crossComputerCiObservation.js'

async function verifyTickets(client: Client, workflow: RunningCiWorkflow, executionId: string,
  observation: ScenarioObservation) {
  const report = observation.reports.get(executionId)
  expect(report, 'Every CI Agent returns a JSON report').toBeDefined()
  if (!report) throw new Error('Missing Agent CI report.')
  const readback = CiGetOutputSchema.parse(await callCiTool(client, 'ci_get', {
    workspaceId: workflow.workspace.workspaceId, ticketId: report.ticketId,
  }))
  const runs = readback.partitions ?? [readback.run]
  expect(readback.group?.state).toBe(report.outcome)
  expect(report.outcome).toBe('passed')
  expect(runs.map(run => run.id)).toContain(report.ticketId)
  const owned = [...observation.tickets.values()].filter(ticket => ticket.initiatingExecutionId === executionId)
  expect(owned.map(ticket => ticket.ticketId).sort()).toEqual(runs.map(run => run.id).sort())
  if (workflow.workspace.project === 'demo') {
    // A repository without the Foreman part hook runs each suite as one repository-defined job.
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ part: null, partition: null })
  } else if (report.suite === 'integration') {
    // Placement sizes the parts from free slots; each tier must still be one complete partition set.
    expect(runs.length).toBeGreaterThanOrEqual(2)
    expect(runs.every(run => run.part === null && run.partition)).toBe(true)
    for (const tier of new Set(runs.map(run => run.partition?.tier))) {
      const shards = runs.filter(run => run.partition?.tier === tier)
      expect(shards.map(run => run.partition!.index).sort((left, right) => left - right))
        .toEqual(Array.from({ length: shards.length }, (_, index) => index))
      expect(shards.every(run => run.partition!.count === shards.length)).toBe(true)
    }
  } else {
    expect(runs.length).toBeGreaterThanOrEqual(2)
    expect(runs.every(run => run.part?.startsWith(`${report.suite}-`))).toBe(true)
    if (report.suite === 'build' || report.suite === 'lint') {
      expect(runs.map(run => run.part).sort()).toEqual([`${report.suite}-api`, `${report.suite}-other`])
    }
    for (const part of new Set(runs.map(run => run.part))) {
      const shards = runs.filter(run => run.part === part)
      if (shards.some(run => run.partition)) {
        expect(shards.map(run => run.partition?.index).sort((left, right) => left! - right!))
          .toEqual(Array.from({ length: shards.length }, (_, index) => index))
        expect(shards.every(run => run.partition?.count === shards.length)).toBe(true)
      } else {
        expect(shards).toHaveLength(1)
      }
    }
  }
  const groupLogs = CiLogsOutputSchema.parse(await callCiTool(client, 'ci_logs_read', {
    workspaceId: workflow.workspace.workspaceId, ticketId: report.ticketId, group: true, maxBytes: 65_536,
  }))
  expect(groupLogs.parts?.map(part => part.run.id).sort()).toEqual(runs.map(run => run.id).sort())
  for (const run of runs) {
    const observed = observation.tickets.get(run.id)!
    const own = CiGetOutputSchema.parse(await callCiTool(client, 'ci_get', {
      workspaceId: workflow.workspace.workspaceId, ticketId: run.id,
    }))
    expect(own.run).toEqual(run)
    expect(own.run).toEqual(observed.latest)
    expect(run.initiator.executionId).toBe(executionId)
    expect(run.state).toBe('passed')
    expect(run.exitCode).toBe(0)
    expect(run.computer).not.toBeNull()
    expect(run.startedAt).not.toBeNull()
    expect(run.finishedAt).not.toBeNull()
    expect(Date.parse(run.finishedAt!)).toBeGreaterThanOrEqual(Date.parse(run.startedAt!))
    requireCiStateOrder(observed.timeline.map(sample => sample.run.state))
    if (run.id === report.ticketId) {
      requireCiStateOrder(report.observedStates)
      expect(report.observedStates.at(-1)).toBe(run.state)
    }
    expect(groupLogs.parts!.find(part => part.run.id === run.id)!.run).toEqual(run)
    observed.log = await readCiLog(client, { workspaceId: workflow.workspace.workspaceId, ticketId: run.id })
    expect(observed.log.logBytes).toBeGreaterThan(0)
    if (run.id === report.ticketId) {
      expect(observed.log.text.split('\n').some(line => line.trim() === report.logLine),
        'Agent quotes a line from its top-level ticket log').toBe(true)
    }
  }
}

function verifyWorkflowActivity(workflow: RunningCiWorkflow, observation: ScenarioObservation) {
  const executions = observation.runs.get(workflow.runId)!.executions
  const own = [...observation.tickets.values()].filter(ticket => ticket.runId === workflow.runId)
  const agentIds = new Set(executions.map(execution => execution.id))
  const ticketIds = new Set(own.map(ticket => ticket.ticketId))
  const items = [...observation.activities.get(workflow.runId)!.values()]
  for (const item of items) {
    if (item.refs.executionId) expect(agentIds.has(item.refs.executionId)).toBe(true)
    if (item.refs.ciTicketId) {
      expect(ticketIds.has(item.refs.ciTicketId), 'Run activity contains only its own CI tickets').toBe(true)
      const ticket = observation.tickets.get(item.refs.ciTicketId)!
      expect(item.refs.executionId).toBe(ticket.initiatingExecutionId)
      expect(item.actor && 'agentId' in item.actor ? item.actor.agentId : undefined).toBe(ticket.agentId)
    }
  }
  for (const foreign of observation.tickets.values()) {
    if (foreign.runId !== workflow.runId) expect(JSON.stringify(items)).not.toContain(foreign.ticketId)
  }
  requireCiWorkflowActivity(items, { runId: workflow.runId,
    agentExecutionIds: [...agentIds], ciTicketIds: [...ticketIds] })
  for (const ticket of own) {
    const events = items.filter(item => item.kind === 'job_work' && item.refs.ciTicketId === ticket.ticketId)
      .sort((left, right) => Number(BigInt(left.sequence) - BigInt(right.sequence)))
    expect(events.at(-1)?.status).toBe('completed')
    requireCiStateOrder(events.map(event => event.status === 'completed' ? 'passed' : event.status))
  }
}

async function verifyWorkflow(client: Client, workflow: RunningCiWorkflow, observation: ScenarioObservation) {
  const details = observation.runs.get(workflow.runId)!
  expect(details.run.outcome).toBe('succeeded')
  // A retryable failure (e.g. a transient database timeout) adds an attempt; each Agent still succeeds exactly once.
  const succeeded = details.executions.filter(value => value.result?.outcome === 'succeeded')
  expect(succeeded).toHaveLength(workflow.assignments.length)
  for (const retried of details.executions.filter(value => value.result?.outcome !== 'succeeded')) {
    expect(retried.result?.error?.retryable, `Execution ${retried.id} failed without a retry`).toBe(true)
  }
  const scope = { workspaceId: workflow.workspace.workspaceId, runId: workflow.runId }
  const executions = RunExecutionsPageSchema.parse(await callCiTool(client, 'run_executions_list', { ...scope, limit: 100 }))
  expect(executions.pageInfo.nextCursor).toBeNull()
  for (const assignment of workflow.assignments) {
    const execution = succeeded.find(value => value.agentId === assignment.agentId)!
    expect(execution.state).toBe('completed')
    expect(execution.result?.outcome).toBe('succeeded')
    const worktree = executions.items.find(value => value.executionId === execution.id)?.worktree
    expect(worktree?.repository).toBe(workflow.repository)
    expect(worktree?.branch).toBeTruthy()
    expect(details.worktrees?.find(tree => tree.executionId === execution.id)?.branch).toBe(worktree!.branch)
    expect(execution.workingDirectory).toBeTruthy()
    const placement = RunPlacementGetResultSchema.parse(await callCiTool(client, 'run_node_placement_get', {
      ...scope, workflowId: workflow.graph.id, nodeId: assignment.nodeId,
    })).readback
    expect(placement.evidence).toBe('accepted')
    if (placement.evidence === 'accepted') expect(placement.placement.hostRef).toEqual(assignment.profile.target.hostRef)
    if (!assignment.suite) {
      expect(observation.groups.has(execution.id)).toBe(false)
      continue
    }
    const report = observation.reports.get(execution.id)!
    expect(report.suite).toBe(assignment.suite)
    expect(report.repository).toBe(worktree!.repository)
    await verifyTickets(client, workflow, execution.id, observation)
  }
  verifyWorkflowActivity(workflow, observation)
}

function verifyScheduling(tickets: TicketObservation[], observation: ScenarioObservation) {
  // Cloud runner slots are separate machines; the PC and Main stay out of the CI lane.
  const computers = new Set(tickets.map(ticket => JSON.stringify(ticket.latest.computer!.hostRef)))
  expect(computers.size, 'At least two computers each execute some work').toBeGreaterThanOrEqual(2)
  expect(observation.concurrencyWitness, 'Observe all workflow CI requests pending concurrently').not.toBeNull()
  expect(observation.queueWitness, 'Observe tickets queued while CI computers run other tickets').not.toBeNull()
  const witness = observation.queueWitness!
  for (const id of witness.queued) {
    expect(tickets.find(ticket => ticket.ticketId === id)?.timeline.some(sample => sample.run.state === 'queued')).toBe(true)
  }
  for (const id of witness.active) {
    expect(tickets.find(ticket => ticket.ticketId === id)?.timeline.some(sample =>
      ['starting', 'running'].includes(sample.run.state) && sample.run.computer)).toBe(true)
  }
}

export async function verifyCiScenario(client: Client, workflows: RunningCiWorkflow[],
  observation: ScenarioObservation, input: CrossComputerCiInput) {
  const expected = workflows.reduce((count, workflow) => count + workflow.assignments.filter(agent => agent.suite).length, 0)
  expect(observation.groups.size, 'No lost or duplicated CI requests').toBe(expected)
  for (const workflow of workflows) await verifyWorkflow(client, workflow, observation)
  const branches: string[] = []
  const directories: string[] = []
  for (const workflow of workflows) {
    for (const execution of observation.runs.get(workflow.runId)!.executions) {
      const assignment = workflow.assignments.find(agent => agent.agentId === execution.agentId)!
      const tree = observation.runs.get(workflow.runId)!.worktrees!.find(value => value.executionId === execution.id)!
      branches.push(`${workflow.repository}:${tree.branch}`)
      directories.push(`${JSON.stringify(assignment.profile.target.hostRef)}:${execution.workingDirectory}`)
    }
  }
  expect(new Set(branches).size, 'Every Agent has its own branch').toBe(branches.length)
  expect(new Set(directories).size, 'Every Agent has its own worktree').toBe(directories.length)
  const tickets = [...observation.tickets.values()]
  verifyScheduling(tickets, observation)
  for (const workspace of input.workspaces) {
    const providers = new Set(workspace.ciComputers.filter(host => host.kind === 'cloud').map(host => host.provider))
    for (const provider of providers) {
      expect(tickets.some(ticket => ticket.workspaceId === workspace.workspaceId
        && ticket.latest.computer?.hostRef.provider === provider), 'Configured cloud CI also executes work').toBe(true)
    }
  }
}
