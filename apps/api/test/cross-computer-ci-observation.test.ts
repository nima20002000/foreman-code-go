import { readFileSync } from 'node:fs'
import type { Client } from '@modelcontextprotocol/client'
import { expect, it, vi } from 'vitest'
import { createScenarioObservation, pollCiScenario,
  type RunningCiWorkflow } from './helpers/crossComputerCiObservation.js'

function fixture() {
  const recorded = JSON.parse(readFileSync(new URL('./fixtures/cross-computer-ci.json', import.meta.url), 'utf8'))
  const workflow = recorded.workflows[0]
  const details = recorded.runs[0]
  const ticket = recorded.tickets[0].latest
  const prepared = { workspace: { workspaceId: workflow.workspaceId }, graph: { id: workflow.workflowId },
    saved: { version: { id: workflow.workflowVersionId } }, runId: workflow.runId, repository: workflow.repository,
    assignments: workflow.assignments } as RunningCiWorkflow
  const activity = { scope: recorded.activities['run-1'][0].scope, items: recorded.activities['run-1'],
    mode: 'initial', highWater: '3', retainedFrom: '0', nextCursor: 'cursor', olderCursor: null, hasMore: false }
  const replies: Record<string, unknown> = {
    run_get: details, ci_get: recorded.groups[ticket.groupId], ci_list: recorded.ciLists['run-1'],
    run_activities_get_v1: activity,
  }
  const callTool = vi.fn<Client['callTool']>(async request => {
    if (!(request.name in replies)) throw new Error(`Unexpected tool ${request.name}`)
    return { content: [], structuredContent: replies[request.name] }
  })
  return { ticket, prepared, replies, activity, observation: createScenarioObservation(), callTool,
    client: { callTool } as unknown as Client }
}

it('discovers tickets from product initiators without a copied identifier in the Agent report', async () => {
  const f = fixture()
  await pollCiScenario(f.client, [f.prepared], f.observation, async () => undefined)
  expect(f.observation.tickets.get(f.ticket.id)?.latest).toEqual(expect.objectContaining(f.ticket))
  expect(f.observation.reports.get('execution-1')).not.toHaveProperty('ticketId')
  expect(f.callTool.mock.calls.some(([request]) => request.name === 'ci_list')).toBe(true)
})

it('waits for delayed ticket publication after a workflow completes', async () => {
  vi.useFakeTimers()
  try {
    const f = fixture()
    const ciList = f.replies.ci_list
    f.replies.ci_list = { runId: 'run-1', jobs: [], truncated: false }
    f.replies.run_activities_get_v1 = { ...f.activity, items: [], highWater: '0' }
    const pending = pollCiScenario(f.client, [f.prepared], f.observation, async () => undefined)
    await vi.advanceTimersByTimeAsync(500)
    f.replies.ci_list = ciList
    f.replies.run_activities_get_v1 = f.activity
    await vi.runAllTimersAsync()
    await pending
    expect(f.observation.tickets.has(f.ticket.id)).toBe(true)
  } finally {
    vi.useRealTimers()
  }
})

it('records malformed reports for replay instead of failing before readbacks are collected', async () => {
  const f = fixture()
  const details = f.replies.run_get as { executions: { result: { output: unknown } }[] }
  details.executions[0]!.result.output = 'not JSON'
  await pollCiScenario(f.client, [f.prepared], f.observation, async () => undefined)
  expect(f.observation.tickets.has(f.ticket.id)).toBe(true)
  expect(f.observation.reports.get('execution-1')).toBe('not JSON')
})

it('collects failed file results for every failed partition after the group settles', async () => {
  const f = fixture()
  const failed = { ...structuredClone(f.ticket), id: '22222222-2222-4222-8222-000000000003',
    state: 'failed', exitCode: 1 }
  const tests = { summary: { passed: 0, failed: 1, skipped: 0 }, truncated: false,
    files: [{ file: 'apps/api/test/example.test.ts', status: 'failed', durationMs: 1,
      tests: [{ name: 'normalizes a label', status: 'failed', durationMs: 1 }] }] }
  f.callTool.mockImplementation(async request => {
    if (request.name === 'ci_get') {
      const run = request.arguments!.ticketId === failed.id ? failed : f.ticket
      return { content: [], structuredContent: { run, partitions: [f.ticket, failed],
        group: { groupId: failed.groupId, state: 'failed' },
        ...(request.arguments!.testStatus ? { tests } : {}) } }
    }
    if (!(request.name in f.replies)) throw new Error(`Unexpected tool ${request.name}`)
    return { content: [], structuredContent: f.replies[request.name] }
  })
  const items = [...f.activity.items]
  for (const [index, item] of f.activity.items.filter((item: { kind: string }) => item.kind === 'job_work').entries()) {
    items.push({ ...structuredClone(item), id: `failed-activity-${index}`, sequence: String(items.length + 1),
      refs: { ...item.refs, ciTicketId: failed.id }, status: item.status === 'completed' ? 'failed' : item.status })
  }
  f.replies.run_activities_get_v1 = { ...f.activity, items, highWater: String(items.length) }
  await pollCiScenario(f.client, [f.prepared], f.observation, async () => undefined)
  expect(f.observation.tickets.get(failed.id)?.tests).toEqual(tests)
  expect(f.callTool.mock.calls.some(([request]) => request.name === 'ci_get'
    && request.arguments?.ticketId === failed.id && Array.isArray(request.arguments?.testStatus))).toBe(true)
})
