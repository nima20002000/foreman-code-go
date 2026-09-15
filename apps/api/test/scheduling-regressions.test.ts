import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

import type { WorkflowVersion } from '@graphql/contracts'
import { it } from 'vitest'

import { ExecutionLimiter } from '../src/modules/runs/limiter.js'
import { validateExecutableTopology } from '../src/modules/runs/topology.js'

for (const maximum of [1, 2]) {
  it(`never exceeds maxParallelism=${maximum} during delayed fan-out work`, async () => {
    const limiter = new ExecutionLimiter(maximum)
    const signal = new AbortController().signal
    let active = 0
    let peak = 0
    await Promise.all(Array.from({ length: 8 }, () => limiter.run(signal, async () => {
      active += 1
      peak = Math.max(peak, active)
      await delay(15)
      active -= 1
    })))
    assert.equal(active, 0)
    assert.equal(peak, maximum)
  })
}

it('does not launch a canceled waiter and returns slots after failures', async () => {
  const limiter = new ExecutionLimiter(1)
  const controller = new AbortController()
  const first = limiter.run(new AbortController().signal, async () => { await delay(20); throw new Error('first failed') })
  const firstRejected = assert.rejects(first, /first failed/)
  let called = false
  const waiting = limiter.run(controller.signal, async () => { called = true })
  const waitingRejected = assert.rejects(waiting)
  controller.abort()
  await Promise.all([firstRejected, waitingRejected])
  assert.equal(called, false)
  assert.equal(await limiter.run(new AbortController().signal, async () => 'released'), 'released')
})

type WorkflowJoin = NonNullable<WorkflowVersion['definition']['nodes'][number]['join']>

function graph(join: WorkflowJoin | undefined, predecessorCount: number): WorkflowVersion {
  const edges = predecessorCount === 0 ? [] : predecessorCount === 1
    ? [{ source: 'a', target: 'c' }]
    : [{ source: 'a', target: 'b' }, { source: 'a', target: 'c' }, { source: 'b', target: 'c' }]
  const ids = predecessorCount === 0 ? ['c'] : predecessorCount === 1 ? ['a', 'c'] : ['a', 'b', 'c']
  return {
    id: 'version', workflowId: 'workflow', workspaceId: 'workspace', version: 1,
    entryNodeId: ids[0]!, contentHash: 'sha256:test', createdAt: '2026-09-14T00:00:00.000Z',
    agentConfigurationVersionIds: { agent: 'configuration' },
    definition: {
      id: 'workflow', workspaceId: 'workspace', name: 'Test', version: 1,
      executionCondition: { kind: 'manual' },
      executionPolicy: { maxParallelism: 1, maxNodeExecutions: ids.length },
      nodes: ids.map((id) => ({ id, agentId: 'agent', name: id, ...(id === 'c' && join ? { join } : {}) })),
      edges: edges.map((edge, index) => ({ ...edge, id: String(index), route: { outcomes: ['succeeded'] } })),
    },
  }
}

for (const join of [{ mode: 'threshold', required: 2 }, { mode: 'any' }] satisfies WorkflowJoin[]) {
  for (const predecessors of [0, 1, 2]) {
    it(`rejects ${join.mode} joins with ${predecessors} predecessors`, () => {
      assert.throws(() => validateExecutableTopology(graph(join, predecessors)), { code: 'WORKFLOW_JOIN_UNSUPPORTED' })
    })
  }
}

it('validates an all-join with unequal predecessor path lengths', () => {
  const topology = validateExecutableTopology(graph({ mode: 'all' }, 2))
  assert.deepEqual(topology.incoming.get('c'), ['a', 'b'])
  assert.deepEqual(topology.sinks, ['c'])
})
