import { readFileSync } from 'node:fs'
import type { Client } from '@modelcontextprotocol/client'
import { afterEach, expect, it, vi } from 'vitest'
import { collectCiReadback, recordScenario, type RecordedScenario } from './helpers/crossComputerCiRecording.js'
import { createScenarioObservation, pollCiScenario, type RunningCiWorkflow } from './helpers/crossComputerCiObservation.js'
import type { CrossComputerCiInput } from './helpers/crossComputerCiInput.js'
import { verifyScenario } from './helpers/crossComputerCiVerification.js'

afterEach(() => vi.useRealTimers())

it('collects delayed public readbacks into one JSON value that replays offline', async () => {
  vi.useFakeTimers()
  const recorded: RecordedScenario = JSON.parse(readFileSync(new URL('./fixtures/cross-computer-ci.json', import.meta.url), 'utf8'))
  const workflows = recorded.workflows.map(workflow => ({
    workspace: { workspaceId: workflow.workspaceId, project: workflow.project }, graph: { id: workflow.workflowId },
    saved: { version: { id: workflow.workflowVersionId } }, runId: workflow.runId, repository: workflow.repository,
    assignments: workflow.assignments.map(agent => ({ ...agent, profile: { target: { hostRef: agent.hostRef } } })),
  })) as RunningCiWorkflow[]
  const observation = createScenarioObservation()
  let published = false
  const callTool = vi.fn<Client['callTool']>(async request => {
    const args = request.arguments!
    const workflow = recorded.workflows.find(value => value.runId === args.runId
      || recorded.tickets.some(ticket => ticket.runId === value.runId && ticket.ticketId === args.ticketId))!
    if (workflow.workspaceId !== args.workspaceId) {
      return { isError: true, content: [], structuredContent: { error: { code: 'NOT_FOUND' } } }
    }
    let result: unknown
    if (request.name === 'run_get') result = recorded.runs.find(value => value.run.id === args.runId)
    else if (request.name === 'ci_list') result = recorded.ciLists[workflow.runId]
    else if (request.name === 'ci_get') result = Object.values(recorded.groups).find(value => value.run.id === args.ticketId)
    else if (request.name === 'run_activities_get_v1') {
      const items = recorded.activities[workflow.runId]!
      result = { scope: items[0]!.scope, items, mode: 'initial', highWater: '3', retainedFrom: '0',
        nextCursor: 'cursor', olderCursor: null, hasMore: false }
    } else if (request.name === 'run_executions_list') {
      const page = structuredClone(recorded.executions[workflow.runId]![0]!)
      if (!published) delete page.items[0]!.worktree
      result = page
    } else if (request.name === 'run_node_placement_get') {
      result = Object.values(recorded.placements).find(value => value.nodeId === args.nodeId)
    } else if (request.name === 'ci_logs_read') {
      const ticket = recorded.tickets.find(value => value.ticketId === args.ticketId)!
      result = args.group ? recorded.groupLogs[ticket.latest.groupId]
        : { ...ticket.log, nextOffset: ticket.log!.logBytes, maxBytes: 65_536 }
    } else throw new Error(`Unexpected tool ${request.name}`)
    return { content: [], structuredContent: result }
  })
  const client = { callTool } as unknown as Client
  const input = { workspaces: recorded.workspaces, excludedComputers: [] } as unknown as CrossComputerCiInput
  await pollCiScenario(client, workflows, observation, async () => undefined)
  const pending = collectCiReadback(client, workflows, observation, input)
  await vi.advanceTimersByTimeAsync(500)
  published = true
  await vi.runAllTimersAsync()
  await pending
  expect(observation.readErrors).toEqual([])
  const replay = JSON.parse(JSON.stringify(recordScenario(workflows, observation, input)))
  expect(replay.placements).toHaveProperty('execution-1')
  expect(replay.tickets.every((ticket: { log: unknown }) => ticket.log)).toBe(true)
  expect(() => verifyScenario(replay)).not.toThrow()
})
