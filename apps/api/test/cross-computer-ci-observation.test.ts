import { randomUUID } from 'node:crypto'
import type { Client } from '@modelcontextprotocol/client'
import { CiRunRecordSchema } from '@foreman-code/contracts'
import { SavedRunDetailsSchema } from '@foreman-code/contracts/wave25'
import { expect, it, vi } from 'vitest'
import { createScenarioObservation, pollCiScenario,
  type RunningCiWorkflow } from './helpers/crossComputerCiObservation.js'

function fixture() {
  const now = '2026-10-14T00:00:00.000Z'
  const scope = { workspaceId: 'workspace', workflowId: 'workflow', workflowVersionId: 'version',
    runId: 'run', executionSemanticsVersion: 3 as const }
  const run = CiRunRecordSchema.parse({ id: randomUUID(), groupId: randomUUID(), workspaceId: scope.workspaceId,
    suite: 'unit', repository: 'example/project', commit: 'a'.repeat(40), partition: null,
    state: 'passed', computer: { hostRef: { kind: 'main', mainId: 'main' }, label: 'Executor' },
    step: null, exitCode: 0, message: null, queuedAt: now, startedAt: now, finishedAt: now,
    initiator: { principalId: 'operator', executionId: 'execution' } })
  const details = SavedRunDetailsSchema.parse({
    run: { id: scope.runId, workspaceId: scope.workspaceId, workflowId: scope.workflowId,
      workflowVersionId: scope.workflowVersionId, executionSemanticsVersion: 3, agentConfigurationVersionIds: { agent: 'configuration' },
      approval: { handler: 'user' }, executionCondition: { kind: 'manual' }, executionState: 'completed',
      outcome: 'succeeded', result: { outcome: 'succeeded', output: {} }, input: {}, createdAt: now, finishedAt: now },
    executions: [{ id: 'execution', runId: scope.runId, workflowNodeId: 'node', agentId: 'agent',
      agentConfigurationVersionId: 'configuration', attempt: 1, state: 'running', input: {}, createdAt: now }],
    activity: [],
  })
  // Observation reads only these fields from the prepared workflow.
  const workflow = { workspace: { workspaceId: scope.workspaceId }, graph: { id: scope.workflowId },
    saved: { version: { id: scope.workflowVersionId } }, runId: scope.runId, repository: run.repository,
    assignments: [{ agentId: 'agent', suite: 'unit' }] } as RunningCiWorkflow
  const observation = createScenarioObservation()
  const replies: Record<string, unknown> = {
    run_get: details,
    run_activities_get_v1: { scope, items: [], mode: 'initial', highWater: '0', retainedFrom: '0',
      nextCursor: 'cursor', olderCursor: null, hasMore: false },
    run_events_list: { items: [], pageInfo: { nextCursor: null } },
    ci_computers_list: { computers: [{ label: 'Executor', hostRef: run.computer!.hostRef,
      priority: 0, ready: true, reasons: [], slotsUsed: 0, slotsTotal: 1, running: [run.id] }] },
    ci_get: { run },
  }
  const ticketReads = vi.fn<() => Promise<Awaited<ReturnType<Client['callTool']>>>>()
    .mockResolvedValue({ content: [], structuredContent: { run } })
  const callTool = vi.fn<Client['callTool']>(async (request) => {
    if (request.name === 'ci_get') return ticketReads()
    if (!(request.name in replies)) throw new Error(`Unexpected tool ${request.name}`)
    return { content: [], structuredContent: replies[request.name] }
  })
  return { run, workflow, observation, ticketReads, callTool,
    client: { callTool } as unknown as Client }
}

function toolError(code: string): Awaited<ReturnType<Client['callTool']>> {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code, message: 'Read failed.' } }) }] }
}

it('retries a transient discovered-ticket read and retains the recovered ticket', async () => {
  const f = fixture()
  f.ticketReads.mockResolvedValueOnce(toolError('DATABASE_READ_TIMEOUT'))
  const persist = vi.fn(async () => undefined)
  await pollCiScenario(f.client, [f.workflow], f.observation, persist)
  expect(f.ticketReads).toHaveBeenCalledTimes(2)
  expect(f.observation.tickets.get(f.run.id)?.latest).toEqual(f.run)
  expect(f.observation.groups.get('execution')?.run).toEqual(f.run)
  expect(f.callTool.mock.calls.filter(([request]) => request.name === 'ci_get')).toEqual([
    [{ name: 'ci_get', arguments: { workspaceId: 'workspace', ticketId: f.run.id } }, { timeout: 180_000 }],
    [{ name: 'ci_get', arguments: { workspaceId: 'workspace', ticketId: f.run.id } }, { timeout: 180_000 }],
  ])
  expect(persist).toHaveBeenCalledOnce()
})

it('ignores scoped not-found inventory tickets after a transient read error', async () => {
  const f = fixture()
  f.workflow.assignments[0]!.suite = null
  f.ticketReads.mockResolvedValueOnce(toolError('DATABASE_READ_TIMEOUT'))
    .mockResolvedValueOnce(toolError('CI_RUN_NOT_FOUND'))
  await pollCiScenario(f.client, [f.workflow], f.observation, async () => undefined)
  expect(f.ticketReads).toHaveBeenCalledTimes(2)
  expect(f.observation.tickets.size).toBe(0)
})

it.each(['CI_RUN_NOT_FOUND', 'ACCESS_DENIED'])('rejects %s for a discovered activity ticket', async code => {
  const f = fixture()
  f.observation.candidates.set(f.workflow.runId, new Set([f.run.id]))
  f.ticketReads.mockResolvedValueOnce(toolError(code))
  await expect(pollCiScenario(f.client, [f.workflow], f.observation, async () => undefined)).rejects.toThrow()
  expect(f.ticketReads).toHaveBeenCalledTimes(1)
})
