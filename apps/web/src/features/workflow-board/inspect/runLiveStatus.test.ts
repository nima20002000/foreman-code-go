import { describe, expect, it } from 'vitest'
import type { CiActivity, DurableInteraction } from '@foreman-code/contracts'
import type { RepeatGraphCurrentV3 } from '@foreman-code/contracts/wave25'
import { ciComputerLabel, ciJobLabel, interactionWaits, liveNodeView } from './runLiveStatus'

const id = (node: string) => ({ workflowNodeId: node, executionId: `x-${node}`, agentId: `agent-${node}`, agentConfigurationVersionId: `cfg-${node}`, attempt: 1 })
function record(executionState = 'waiting') {
  return { scope: { runId: 'run-1' }, topology: { nodes: ['a', 'b', 'c'].map((node) => ({ workflowNodeId: node, kind: 'agent', agentId: `agent-${node}` })) },
    state: { run: { executionState }, executions: ['a', 'b'].map((node) => ({ identity: { ...id(node), occurrence: null } })),
      interactions: [{ interactionId: 'i-b', requester: id('b'), reviewer: id('c') }] } } as unknown as RepeatGraphCurrentV3
}
const request = (node: string, fields: Partial<DurableInteraction>) => ({ id: `i-${node}`, runId: 'run-1', executionId: `x-${node}`,
  requestingAgentId: `agent-${node}`, status: 'pending', createdAt: '2026-10-01T00:00:00.000Z', approval: { handler: 'user' }, ...fields }) as DurableInteraction
const names = new Map([['a', 'Coder'], ['b', 'Fixer'], ['c', 'Lead']])
const ci = (fields: Partial<CiActivity>) => ({ id: 't', suite: 'integration', part: null, partition: null, state: 'running',
  computer: null, step: null, ...fields }) as CiActivity

describe('live Run waits', () => {
  it('names the reason each Agent waits instead of leaving it idle', () => {
    const waits = interactionWaits(record(), [request('a', { kind: 'work_direction' }),
      request('b', { approval: { handler: 'orchestrator', designatedOrchestratorAgentId: 'agent-c' } }),
      request('c', { executionId: 'outside-cut', status: 'delivered' })], names)
    expect(Object.fromEntries([...waits].map(([node, wait]) => [node, [wait.label, wait.actionable]]))).toEqual({
      a: ['Waiting for your decision', true], b: ['Waiting for approval from Lead', false] })
    expect(interactionWaits(record(), [request('c', { executionId: 'outside-cut' })], names).get('c')?.label).toBe('Waiting for your approval')
    expect(interactionWaits(record('completed'), [request('a', {})], names).size).toBe(0)
    expect(interactionWaits(record(), [request('a', { runId: 'other-run' })], names).size).toBe(0)
  })

  it('shows unfinished CI as a wait and keeps finished CI beside the lifecycle', () => {
    const running = { state: 'running' as const, label: 'Running' }
    expect(liveNodeView(running, undefined, ci({ part: 'integration' as never }))).toEqual({ state: 'waiting', label: 'Waiting for CI integration · running' })
    expect(liveNodeView(running, undefined, ci({ state: 'passed' }))).toEqual({ state: 'running', label: 'Running · CI integration · passed' })
    expect(liveNodeView(running, { interactionId: 'i', label: 'Waiting for your decision', actionable: true }, undefined))
      .toEqual({ state: 'waiting', label: 'Waiting for your decision' })
    expect(liveNodeView(running, undefined, undefined)).toBe(running)
  })

  it('describes the CI part, partition and computer', () => {
    expect(ciJobLabel(ci({ partition: { index: 1, count: 4 } as never }))).toBe('integration · partition 2 of 4')
    expect(ciComputerLabel(ci({}))).toBe('Waiting for a computer')
    expect(ciComputerLabel(ci({ computer: { hostRef: { kind: 'device', mainId: 'm', deviceId: 'd' }, label: 'Laptop' } }))).toBe('Laptop · build computer')
    expect(ciComputerLabel(ci({ computer: { hostRef: { kind: 'cloud', mainId: 'm', provider: 'circleci', slot: 0 }, label: 'CircleCI 1' } }))).toBe('CircleCI 1')
  })
})
