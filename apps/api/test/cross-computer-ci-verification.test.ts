import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { CiGetOutputSchema, CiListOutputSchema, CiRunRecordSchema } from '@foreman-code/contracts'
import { RunActivitiesPageSchema } from '@foreman-code/contracts/wave25'
import * as verifier from './helpers/crossComputerCiVerification.js'

function fixture(): Parameters<typeof verifier.verifyScenario>[0] {
  return JSON.parse(readFileSync(new URL('./fixtures/cross-computer-ci.json', import.meta.url), 'utf8'))
}

it('replays a saved round offline with terminal-only samples and product-owned identifiers', () => {
  const recorded = fixture()
  recorded.tickets[0]!.latest.smokeComputer = recorded.tickets[0]!.latest.computer!.hostRef
  expect(() => verifier.verifyScenario(recorded)).not.toThrow()
})

it('requires tickets to execute on at least two computers', () => {
  const recorded = fixture()
  recorded.tickets[1]!.latest.computer = recorded.tickets[0]!.latest.computer
  expect(() => verifier.verifyScenario(recorded)).toThrow('At least two computers')
})

it('collects independent product failures in one diagnostic', () => {
  const recorded = fixture()
  recorded.runs[0]!.run.outcome = 'failed'
  recorded.reports['execution-1'] = { ...recorded.reports['execution-1'] as object, logLine: 'Invented log line' }
  recorded.tickets[1]!.latest.initiator.executionId = 'foreign-execution'
  expect(() => verifier.verifyScenario(recorded)).toThrow(/workflow.*outcome[\s\S]*logLine[\s\S]*executionId/i)
})

it.each(['scope', 'owner', 'order', 'reference'] as const)('rejects incorrect activity %s', change => {
  const recorded = fixture()
  const items = recorded.activities['run-1']!
  const job = items[1]!
  if (change === 'scope') job.scope.runId = 'run-2'
  if (change === 'owner') job.refs.executionId = 'execution-2'
  if (change === 'order') job.sequence = '4'
  if (change === 'reference') {
    job.refs.jobExecutionId = job.refs.ciTicketId!
    delete job.refs.ciTicketId
  }
  expect(() => verifier.verifyScenario(recorded)).toThrow()
})

it('checks each Agent succeeds once and has its own product worktree branch', () => {
  const recorded = fixture()
  recorded.runs[0]!.executions.push({ ...recorded.runs[0]!.executions[0]!, id: 'duplicate' })
  recorded.workflows[1]!.repository = recorded.workflows[0]!.repository
  recorded.runs[1]!.worktrees![0]!.branch = recorded.runs[0]!.worktrees![0]!.branch
  expect(() => verifier.verifyScenario(recorded)).toThrow(/succeeds once[\s\S]*own branch/)
})

it('accepts an idle configured cloud provider unless that workspace\'s tickets waited in the queue', () => {
  const recorded = fixture()
  const circleci = { ...recorded.tickets[0]!.latest.computer!.hostRef, provider: 'circleci' as const }
  recorded.workspaces[0]!.ciComputers.push(circleci)
  expect(() => verifier.verifyScenario(recorded)).not.toThrow()
  const ticket = recorded.tickets[0]!
  const queued = { ...ticket.timeline[0]!.run, state: 'queued' as const }
  ticket.timeline.unshift({ observedAt: '2026-01-01T00:00:00.000Z', run: queued },
    { observedAt: '2026-01-01T00:01:00.000Z', run: queued })
  expect(() => verifier.verifyScenario(recorded)).toThrow('Configured circleci CI executes work while tickets wait')
})

function joinedFixture() {
  const recorded = fixture()
  for (const ticket of recorded.tickets) {
    ticket.latest = CiRunRecordSchema.parse(ticket.latest)
    ticket.timeline = ticket.timeline.map(sample => ({ ...sample, run: CiRunRecordSchema.parse(sample.run) }))
  }
  for (const log of Object.values(recorded.groupLogs)) {
    for (const part of log.parts ?? []) part.run = CiRunRecordSchema.parse(part.run)
  }
  for (const [id, group] of Object.entries(recorded.groups)) recorded.groups[id] = CiGetOutputSchema.parse(group)
  const workflow = recorded.workflows[0]!
  const details = recorded.runs[0]!
  const original = details.executions[0]!
  const executionId = 'joined-execution'
  const agentId = 'joined-agent'
  const nodeId = 'joined-node'
  workflow.assignments.push({ ...workflow.assignments[0]!, agentId, nodeId })
  details.executions.push({ ...original, id: executionId, agentId, workflowNodeId: nodeId,
    workingDirectory: '/projects/joined' })
  details.worktrees!.push({ ...details.worktrees![0]!, executionId,
    workingDirectory: '/projects/joined', branch: 'agent/joined' })
  const page = recorded.executions[workflow.runId]![0]!
  page.items.push({ ...page.items[0]!, executionId, agentId, workflowNodeId: nodeId,
    worktree: { ...page.items[0]!.worktree!, branch: 'agent/joined' } } as typeof page.items[number])
  const placement = structuredClone(recorded.placements[original.id]!)
  placement.nodeId = nodeId
  if (placement.readback.evidence !== 'accepted') throw new Error('Expected accepted placement')
  placement.readback.placement.nodeId = nodeId
  recorded.placements[executionId] = placement
  recorded.reports[executionId] = recorded.reports[original.id]
  const groupId = recorded.tickets[0]!.latest.groupId
  const group = recorded.groups[groupId]!
  recorded.groups[groupId] = CiGetOutputSchema.parse({ ...group, sharing: { requesters: [
    { ...group.run.initiator, initiator: true, active: true },
    { principalId: 'joined-principal', executionId, initiator: false, active: true },
  ] } })
  const listed = recorded.ciLists[workflow.runId]!
  recorded.ciLists[workflow.runId] = CiListOutputSchema.parse({ ...listed, jobs: [...listed.jobs,
    { ...listed.jobs[0]!, requester: { executionId, agentId, nodeId, nodeName: 'Joined Agent' } },
  ] })
  const items = recorded.activities[workflow.runId]!
  const joined = items.map((item, index) => ({ ...item, id: `joined-activity-${index}`,
    sequence: String(items.length + index + 1),
    actor: { agentId, nodeId, agentName: 'Joined Agent', nodeName: 'Joined Agent' },
    refs: { ...item.refs, executionId } }))
  recorded.activities[workflow.runId] = RunActivitiesPageSchema.parse({
    scope: items[0]!.scope, items: [...items, ...joined], mode: 'initial',
    highWater: String(items.length + joined.length), retainedFrom: '1',
    nextCursor: 'cursor', olderCursor: null, hasMore: false,
  }).items
  return recorded
}

it('counts a shared group once per requester using ci_get, ci_list and activity responses', () => {
  expect(() => verifier.verifyScenario(joinedFixture())).not.toThrow()
})

it.each(['missing', 'extra'] as const)('rejects a %s joined request in the ci_get sharing readback', change => {
  const recorded = joinedFixture()
  const group = recorded.groups[recorded.tickets[0]!.latest.groupId]!
  if (change === 'missing') group.sharing!.requesters.pop()
  else group.sharing!.requesters.push({ principalId: 'extra-principal', executionId: 'extra-execution',
    initiator: false, active: true })
  expect(() => verifier.verifyScenario(recorded)).toThrow('No lost or duplicated CI requests')
})
