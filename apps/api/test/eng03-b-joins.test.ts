import { MemorySaver } from '@langchain/langgraph'
import { describe, expect, it } from 'vitest'
import { graphSourceDigest } from '../src/modules/run-graph/publication.js'
import { buildOneShotGraph } from '../src/modules/runs/oneShotGraph.js'
import { syntheticOneShot } from './helpers/oneShotSynthetic.js'

function latch() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

describe('ENG-03 B join qualification (synthetic native work)', () => {
  it('waits for a slow unequal-depth selected path, skips an unselected path and binds exact results once in relationship order', async () => {
    const fixture = syntheticOneShot(
      ['entry', 'short', 'long1', 'long2', 'unused', 'join'],
      [['entry', 'short'], ['entry', 'long1'], ['long1', 'long2'], ['long1', 'unused'],
        ['short', 'join'], ['long2', 'join'], ['unused', 'join']],
      { long1: { outcomes: [
        { outcome: 'selected', target: { kind: 'edge', relationshipId: 'long1-long2' } },
        { outcome: 'unused', target: { kind: 'edge', relationshipId: 'long1-unused' } },
      ] } },
    )
    const entered = latch(), slow = latch(), fast = latch(), firstPair = latch()
    let firstPairCount = 0
    const driver = fixture.driver(
      (nodeId) => nodeId === 'long1' ? { routing: { outcome: 'selected' }, data: {} } : { from: nodeId },
      async (nodeId) => {
        if (nodeId === 'short' || nodeId === 'long1') {
          if (++firstPairCount === 2) firstPair.release()
          await firstPair.promise
        }
        if (nodeId === 'short') await fast.promise
        if (nodeId === 'long2') { entered.release(); await slow.promise }
      },
    )
    const { graph, config } = buildOneShotGraph({ runId: fixture.runId, version: fixture.version,
      store: fixture.store, driver, checkpointer: new MemorySaver(), signal: new AbortController().signal,
      configuredParallelism: 2 })
    let finished = false
    const invoking = graph.invoke({ runId: fixture.runId, executionIds: {} }, config).then(() => { finished = true })
    await firstPair.promise
    expect(fixture.peak).toBe(2)
    fast.release()
    await entered.promise
    expect(finished).toBe(false)
    expect(fixture.nativeCalls).not.toContain('join')
    await expect.poll(() => fixture.resolutions.get('short')?.resolution).toBe('succeeded')
    expect(finished).toBe(false)
    slow.release()
    await invoking

    expect(fixture.peak).toBeLessThanOrEqual(2)
    expect(fixture.nativeCalls.filter((nodeId) => nodeId === 'join')).toHaveLength(1)
    expect(fixture.nativeCalls).not.toContain('unused')
    expect(fixture.resolutions.get('unused')?.resolution).toBe('skipped')
    const receiver = fixture.executions.get('exec-join')!.execution
    const predecessors = receiver.input as { predecessors: Array<{ relationshipId: string; senderExecutionId: string; acceptedResult: unknown }> }
    expect(predecessors.predecessors.map((item) => item.relationshipId)).toEqual(['long2-join', 'short-join'])
    expect(predecessors.predecessors.map((item) => item.senderExecutionId)).toEqual(['exec-long2', 'exec-short'])
    const bindings = fixture.receipts.filter((item) => item.recipient.executionId === receiver.id)
    expect(bindings.map((item) => [item.relationshipId, item.inputOrdinal])).toEqual([['long2-join', 0], ['short-join', 1]])
    for (const [index, item] of predecessors.predecessors.entries()) {
      const sender = fixture.executions.get(item.senderExecutionId)!
      expect(sender.accepted).toBe(true)
      expect(item.acceptedResult).toEqual(sender.execution.result)
      expect(bindings[index]!.acceptedResultDigest).toBe(graphSourceDigest(sender.execution.result))
      expect(bindings[index]!.recipientInputDigest).toBe(graphSourceDigest(receiver.input))
    }
  })
})
