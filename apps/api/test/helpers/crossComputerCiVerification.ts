import { isDeepStrictEqual } from 'node:util'
import type { CiRunRecord } from '@foreman-code/contracts'
import { readAgentCiReport, requireCiStateOrder } from './crossComputerCiReadback.js'
import type { RecordedScenario } from './crossComputerCiRecording.js'
import type { TicketObservation } from './crossComputerCiObservation.js'

type Check = (condition: unknown, message: string) => void

function sameTicket(left: CiRunRecord | undefined, right: CiRunRecord) {
  // ci_get adds smokeComputer to the requested ticket; partitions and log records omit that projection.
  return left && isDeepStrictEqual({ ...left, smokeComputer: undefined }, { ...right, smokeComputer: undefined })
}

function verifyPartitions(runs: CiRunRecord[], project: string, suite: string, check: Check) {
  if (project === 'demo') {
    check(runs.length === 1 && runs[0]?.part === null && runs[0]?.partition === null,
      'repository-defined suite has one job')
    return
  }
  check(runs.length >= 2, 'suite has all parts')
  if (suite === 'integration') {
    check(runs.every(run => run.part === null && run.partition), 'integration has tier partitions')
  } else {
    check(runs.every(run => run.part?.startsWith(`${suite}-`)), 'parts belong to suite')
    if (suite === 'build' || suite === 'lint') {
      check(isDeepStrictEqual([...new Set(runs.map(run => run.part))].sort(), [`${suite}-api`, `${suite}-other`]),
        'suite includes api and other parts')
    }
  }
  const keys = new Set(runs.map(run => suite === 'integration' ? run.partition?.tier : run.part))
  for (const key of keys) {
    const shards = runs.filter(run => (suite === 'integration' ? run.partition?.tier : run.part) === key)
    if (shards.some(run => run.partition)) {
      check(shards.every(run => run.partition?.count === shards.length), 'partition counts agree')
      check(isDeepStrictEqual(shards.map(run => run.partition?.index).sort((a, b) => a! - b!),
        Array.from({ length: shards.length }, (_, index) => index)), 'partition indexes are complete')
    } else check(shards.length === 1, 'part is not duplicated')
  }
}

function verifyTicket(ticket: TicketObservation, run: CiRunRecord, executionId: string, check: Check) {
  check(sameTicket(ticket.latest, run), `ticket ${run.id} agrees with group readback`)
  check(ticket.latest.initiator.executionId === executionId, `ticket ${run.id} has the right executionId`)
  check(ticket.initiatingExecutionId === executionId, `ticket ${run.id} observer executionId agrees`)
  check(ticket.timeline.every(sample => sample.run.initiator.executionId === executionId
    && sample.run.workspaceId === ticket.workspaceId && sample.run.id === run.id),
  `ticket ${run.id} retains its owner and executionId throughout its lifecycle`)
  check(run.state === 'passed', `ticket ${run.id} passed`)
  check(run.exitCode === 0, `ticket ${run.id} exit code is zero`)
  check(run.computer, `ticket ${run.id} ran on a computer`)
  check(run.startedAt && run.finishedAt && Date.parse(run.finishedAt) >= Date.parse(run.startedAt),
    `ticket ${run.id} has ordered start and finish times`)
  check(ticket.log && ticket.log.logBytes > 0, `ticket ${run.id} has its complete log`)
}

function verifyActivity(recorded: RecordedScenario, workflow: RecordedScenario['workflows'][number], check: Check) {
  const details = recorded.runs.find(value => value.run.id === workflow.runId)
  const executions = details?.executions ?? []
  const tickets = recorded.tickets.filter(ticket => ticket.runId === workflow.runId)
  const items = recorded.activities[workflow.runId] ?? []
  for (const page of recorded.activityPages[workflow.runId] ?? []) {
    check(page.scope.runId === workflow.runId && page.scope.workflowId === workflow.workflowId
      && page.scope.workflowVersionId === workflow.workflowVersionId && page.scope.workspaceId === workflow.workspaceId,
    'Activity page belongs to its own run')
  }
  for (const item of items) {
    check(item.scope.runId === workflow.runId && item.scope.workspaceId === workflow.workspaceId
      && item.scope.workflowId === workflow.workflowId && item.scope.workflowVersionId === workflow.workflowVersionId,
    `activity ${item.id} belongs to its own run`)
    if (item.refs.executionId) {
      check(executions.some(execution => execution.id === item.refs.executionId), `activity ${item.id} executionId belongs to run`)
    }
    if (item.refs.ciTicketId) {
      const ticket = tickets.find(value => value.ticketId === item.refs.ciTicketId)
      check(ticket, `activity ${item.id} ticket belongs to its own run`)
      check(item.refs.executionId === ticket?.initiatingExecutionId, `activity ${item.id} has the right executionId`)
      check(item.actor && 'agentId' in item.actor && item.actor.agentId === ticket?.agentId,
        `activity ${item.id} has the right owner`)
    }
  }
  for (const execution of executions) {
    if (execution.result?.outcome === 'succeeded') {
      check(items.some(item => item.kind === 'agent_work' && item.refs.executionId === execution.id
        && item.status === 'completed'), `Agent ${execution.id} has completed activity`)
    }
  }
  for (const ticket of tickets) {
    const events = items.filter(item => item.kind === 'job_work' && item.refs.ciTicketId === ticket.ticketId)
      .sort((a, b) => BigInt(a.sequence) < BigInt(b.sequence) ? -1 : 1)
    const queued = events.findIndex(item => item.status === 'queued')
    const terminal = events.findIndex(item => ['completed', 'failed', 'canceled'].includes(item.status))
    check(queued >= 0 && terminal > queued, `ticket ${ticket.ticketId} activity has queued then terminal in order`)
    const expected = ticket.latest.state === 'passed' ? 'completed' : ticket.latest.state
    check(events.at(-1)?.status === expected, `ticket ${ticket.ticketId} terminal activity agrees with ticket`)
  }
}

/** Verifies only recorded public readbacks; replay never opens a client or reads a clock. */
export function verifyScenario(recorded: RecordedScenario): void {
  const failures: string[] = [...recorded.readErrors]
  const check: Check = (condition, message) => { if (!condition) failures.push(message) }
  const capture = (label: string, verify: () => void) => {
    try { verify() } catch (error) {
      failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const branches: string[] = []
  const directories: string[] = []
  const groups = Object.values(recorded.groups)
  const expected = recorded.workflows.flatMap(workflow => workflow.assignments).filter(agent => agent.suite).length
  check(groups.length === expected, 'No lost or duplicated CI requests')
  for (const workflow of recorded.workflows) {
    const details = recorded.runs.find(value => value.run.id === workflow.runId)
    check(details?.run.outcome === 'succeeded', `workflow ${workflow.runId} outcome is succeeded`)
    check(details?.run.workflowId === workflow.workflowId
      && details.run.workflowVersionId === workflow.workflowVersionId, `workflow ${workflow.runId} saved version agrees`)
    check(details?.run.executionState === 'completed' && !details.cleanupPending, `workflow ${workflow.runId} completed cleanup`)
    const executions = details?.executions ?? []
    check(executions.every(execution => workflow.assignments.some(agent => agent.agentId === execution.agentId)),
      `workflow ${workflow.runId} has only its own Agents`)
    for (const execution of executions.filter(value => value.result?.outcome !== 'succeeded')) {
      check(execution.result?.error?.retryable, `execution ${execution.id} failed without a retry`)
    }
    const pages = recorded.executions[workflow.runId] ?? []
    check(pages.length && pages.at(-1)?.pageInfo.nextCursor === null, `workflow ${workflow.runId} execution readback is complete`)
    const listed = recorded.ciLists[workflow.runId]
    check(listed && !listed.truncated && listed.runId === workflow.runId, `workflow ${workflow.runId} CI list is complete`)
    for (const job of listed?.jobs ?? []) {
      const ticket = recorded.tickets.find(ticket => ticket.ticketId === job.ticketId)
      check(ticket?.runId === workflow.runId && ticket.agentId === job.requester.agentId
        && ticket.initiatingExecutionId === job.requester.executionId,
      `CI list ticket ${job.ticketId} has its own run, owner and executionId`)
    }
    for (const assignment of workflow.assignments) {
      const succeeded = executions.filter(value => value.agentId === assignment.agentId && value.result?.outcome === 'succeeded')
      check(succeeded.length === 1, `Agent ${assignment.agentId} succeeds once`)
      const execution = succeeded[0]
      if (!execution) continue
      check(execution.state === 'completed', `Agent ${assignment.agentId} completed`)
      const tree = details?.worktrees?.find(value => value.executionId === execution.id)
      const worktree = pages.flatMap(page => page.items).find(value => value.executionId === execution.id)?.worktree
      check(worktree?.repository === workflow.repository && worktree.branch, `Agent ${assignment.agentId} worktree repository and branch`)
      check(tree?.branch && tree.branch === worktree?.branch, `Agent ${assignment.agentId} branch readbacks agree`)
      check(execution.workingDirectory && tree?.workingDirectory === execution.workingDirectory,
        `Agent ${assignment.agentId} worktree directory agrees`)
      if (tree?.branch) branches.push(`${workflow.repository}:${tree.branch}`)
      if (execution.workingDirectory) directories.push(`${JSON.stringify(assignment.hostRef)}:${execution.workingDirectory}`)
      const placement = recorded.placements[execution.id]
      check(placement?.runId === workflow.runId && placement.workflowId === workflow.workflowId
        && placement.nodeId === assignment.nodeId, `Agent ${assignment.agentId} placement belongs to run and node`)
      check(placement?.readback.evidence === 'accepted'
        && isDeepStrictEqual(placement.readback.placement.hostRef, assignment.hostRef), `Agent ${assignment.agentId} placement accepted on chosen computer`)
      const own = groups.filter(group => group.run.initiator.executionId === execution.id)
      check(own.length === (assignment.suite ? 1 : 0), `Agent ${assignment.agentId} has the right number of CI groups`)
      if (!assignment.suite) continue
      let report: ReturnType<typeof readAgentCiReport> | undefined
      capture(`Agent ${assignment.agentId} report`, () => { report = readAgentCiReport(recorded.reports[execution.id]) })
      if (report) {
        check(report.suite === assignment.suite, `Agent ${assignment.agentId} report suite agrees`)
        check(report.repository === worktree?.repository, `Agent ${assignment.agentId} report repository agrees`)
        check(report.outcome === 'passed', `Agent ${assignment.agentId} reports passed`)
        capture(`Agent ${assignment.agentId} observed states`, () => requireCiStateOrder(report!.observedStates))
        check(report.observedStates.at(-1) === 'passed', `Agent ${assignment.agentId} observed terminal state agrees`)
      }
      for (const group of own) {
        const runs = group.partitions ?? [group.run]
        check(group.group?.state === 'passed', `group ${group.run.groupId} passed`)
        check(runs.some(run => run.id === group.run.id), 'Group includes its requested ticket')
        check(new Set(runs.map(run => run.id)).size === runs.length, 'Group tickets are unique')
        const tickets = recorded.tickets.filter(ticket => ticket.initiatingExecutionId === execution.id)
        check(isDeepStrictEqual(tickets.map(ticket => ticket.ticketId).sort(), runs.map(run => run.id).sort()),
          `Agent ${assignment.agentId} owns every group ticket`)
        verifyPartitions(runs, workflow.project, assignment.suite, check)
        const logParts = recorded.groupLogs[group.run.groupId]?.parts ?? []
        check(isDeepStrictEqual(logParts.map(part => part.run.id).sort(), runs.map(run => run.id).sort()), 'Group logs include every ticket')
        for (const run of runs) {
          const ticket = recorded.tickets.find(value => value.ticketId === run.id)
          check(ticket, `ticket ${run.id} was collected`)
          check(run.workspaceId === workflow.workspaceId && run.repository === workflow.repository
            && run.suite === assignment.suite && run.groupId === group.run.groupId && run.scope === 'full'
            && !run.files.length && run.commit === group.run.commit
            && isDeepStrictEqual(run.initiator, group.run.initiator), `ticket ${run.id} request facts agree`)
          if (!ticket) continue
          check(ticket.runId === workflow.runId && ticket.agentId === assignment.agentId, `ticket ${run.id} has its own run and owner`)
          verifyTicket(ticket, run, execution.id, check)
          capture(`ticket ${run.id} sampled lifecycle`, () => requireCiStateOrder(ticket.timeline.map(sample => sample.run.state)))
          check(sameTicket(logParts.find(part => part.run.id === run.id)?.run, run), `ticket ${run.id} group log record agrees`)
        }
        if (report) check(tickets.some(ticket => ticket.log?.text.split('\n').some(line => line.trim() === report!.logLine)),
          `Agent ${assignment.agentId} logLine appears in its ticket log`)
      }
    }
    capture(`workflow ${workflow.runId} activity`, () => verifyActivity(recorded, workflow, check))
  }
  check(new Set(branches).size === branches.length, 'Every Agent has its own branch')
  check(new Set(directories).size === directories.length, 'Every Agent has its own worktree')
  const computers = new Set(recorded.tickets.filter(ticket => ticket.latest.computer)
    .map(ticket => JSON.stringify(ticket.latest.computer!.hostRef)))
  check(computers.size >= 2, 'At least two computers execute tickets')
  for (const workspace of recorded.workspaces) {
    for (const host of workspace.ciComputers.filter(host => host.kind === 'cloud')) {
      check(recorded.tickets.some(ticket => ticket.workspaceId === workspace.workspaceId
        && ticket.latest.computer?.hostRef.provider === host.provider), `Configured ${host.provider} CI executes work`)
    }
  }
  for (const read of recorded.isolation) {
    check(read.isError && !['run', 'partitions', 'text', 'parts'].some(field =>
      read.body && typeof read.body === 'object' && field in read.body), `${read.tool} preserves workspace isolation`)
  }
  for (const excluded of recorded.exclusions) {
    check(!excluded.ready && excluded.reasons.length, 'Excluded computer is unavailable with a reason')
    check(!recorded.tickets.some(ticket => ticket.timeline.some(sample =>
      isDeepStrictEqual(sample.run.computer?.hostRef, excluded.hostRef))), 'Unavailable computers never execute tickets')
  }
  if (failures.length) throw new Error(`Scenario verification failed (${failures.length}):\n${failures.map(message => `- ${message}`).join('\n')}`)
}
