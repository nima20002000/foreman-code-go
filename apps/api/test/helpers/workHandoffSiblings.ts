import { randomUUID } from 'node:crypto'
import type { HarnessExecutionRequest } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture, WorkActivationInputSchema } from '@foreman-code/contracts/wave25'

export function workHandoffSiblings() {
  const fixture = makeCurrentWorkflowFixture(randomUUID(), 'parallel')
  const graph = fixture.version.definition
  graph.handoffs = { contractVersion: 1 }
  graph.executionPolicy = { maxParallelism: 3, maxNodeExecutions: 4 }
  graph.nodes = graph.nodes.map(node => {
    const configured = { ...node }
    delete configured.join
    return configured
  })
  graph.edges = graph.nodes.slice(1).map(node => ({
    id: `${graph.entryNodeId}-${node.id}`,
    kind: 'execution',
    source: graph.entryNodeId,
    target: node.id,
  }))
  return fixture
}

export function handoffOutput(_nodeId: string, request: HarnessExecutionRequest) {
  const { work } = WorkActivationInputSchema.parse(request.input)
  const routing = work.kind === 'work_request'
    ? { kind: 'return' as const, requestId: work.request.requestId, outcome: 'accepted' as const }
    : { kind: 'finish' as const }
  return { routing, data: { latestDeliverable: { ready: true }, remainingFindings: [] } }
}
