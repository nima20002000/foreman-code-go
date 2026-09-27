import { MemorySaver } from '@langchain/langgraph'
import { describe, expect, it } from 'vitest'
import { makeCurrentWorkflowFixture, WorkflowVersionV3Schema } from '@graphql/contracts/wave25'
import { buildWorkHandoffGraph } from '../src/modules/runs/workHandoffGraph.js'

describe('NIM-2691 activation graph', () => {
  it('fans out one entry and runs only the successors returned by durable activation decisions', async () => {
    const fixture = makeCurrentWorkflowFixture('handoff-graph', 'parallel')
    const version = WorkflowVersionV3Schema.parse({ ...fixture.version, definition: {
      ...fixture.version.definition, handoffs: { contractVersion: 1 },
      executionPolicy: { maxParallelism: 2, maxNodeExecutions: 20 },
    } })
    const calls: string[] = []
    const graph = buildWorkHandoffGraph({ runId: fixture.run.id, version, checkpointer: new MemorySaver(),
      signal: new AbortController().signal,
      port: { ensureEntryActivation: async () => 'entry-a', executeActivation: async (id) => {
        calls.push(id)
        return id === 'entry-a' ? ['branch-b', 'branch-c'] : id === 'branch-c' ? ['join-d'] : []
      } },
    })
    await graph.graph.invoke(graph.initial, graph.config)
    expect(calls[0]).toBe('entry-a')
    expect(new Set(calls)).toEqual(new Set(['entry-a', 'branch-b', 'branch-c', 'join-d']))
    expect(calls.filter((id) => id === 'entry-a')).toHaveLength(1)
    expect(calls.indexOf('join-d')).toBeGreaterThan(calls.indexOf('branch-c'))
  })
})
