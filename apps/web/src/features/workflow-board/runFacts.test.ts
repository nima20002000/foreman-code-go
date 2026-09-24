import { describe, expect, it } from 'vitest'
import type { RunGraphRecord } from '../run-graph/types'
import { runEdgeSignal, runNodeView } from './runFacts'

const record = (nodes: Record<string, string>, relationships = [{ relationshipId: 'ab', source: 'a', target: 'b', kind: 'execution' }]): RunGraphRecord => ({
  kind: 'run-graph-cache', epoch: 1, transport: { phase: 'live' },
  scope: { workspaceId: 'w', workflowId: 'f', runId: 'r', workflowVersionId: 'v', executionSemanticsVersion: 2 },
  facts: { reader: 'graph', snapshot: {
    topology: { nodes: Object.keys(nodes).map((id) => ({ workflowNodeId: id, agentId: `agent-${id}` })), relationships },
    state: { run: {}, nodes: Object.entries(nodes).map(([id, lifecycle]) => ({ state: { workflowNodeId: id, lifecycle } })) },
  } },
} as unknown as RunGraphRecord)

describe('board Run facts', () => {
  it('shows Idle without a selected Run and never infers success from missing facts', () => {
    expect(runNodeView(undefined, false, 'a', 'agent-a')).toMatchObject({ state: 'idle', label: 'Idle' })
    expect(runNodeView(undefined, true, 'a', 'agent-a')).toMatchObject({ state: 'unavailable' })
    expect(runNodeView(record({ a: 'uncertain' }), true, 'a', 'agent-a')).toMatchObject({ state: 'unavailable' })
    expect(runNodeView(record({ a: 'running' }), true, 'b', 'agent-b')).toMatchObject({ label: 'Not in this Run' })
  })
  it('maps recorded lifecycles to the fixed status words', () => {
    expect(runNodeView(record({ a: 'running' }), true, 'a', 'agent-a')).toMatchObject({ state: 'running', label: 'Running' })
    expect(runNodeView(record({ a: 'succeeded' }), true, 'a', 'agent-a')).toMatchObject({ state: 'completed', label: 'Completed' })
    expect(runNodeView(record({ a: 'failed' }), true, 'a', 'agent-a')).toMatchObject({ state: 'failed', label: 'Failed' })
  })
  it('lights a handoff only while its receiver works after the sender finished, and marks failures', () => {
    expect(runEdgeSignal(record({ a: 'succeeded', b: 'running' }), 'ab', 'a', 'b')).toBe('task')
    expect(runEdgeSignal(record({ a: 'succeeded', b: 'failed' }), 'ab', 'a', 'b')).toBe('error')
    expect(runEdgeSignal(record({ a: 'running', b: 'not_activated' }), 'ab', 'a', 'b')).toBeUndefined()
    expect(runEdgeSignal(undefined, 'ab', 'a', 'b')).toBeUndefined()
  })
  it('never lights a connection that only exists in the draft', () => {
    expect(runEdgeSignal(record({ a: 'succeeded', b: 'running' }), 'draft-only', 'a', 'b')).toBeUndefined()
    expect(runEdgeSignal(record({ a: 'succeeded', b: 'running' }, []), 'ab', 'a', 'b')).toBeUndefined()
  })
})
