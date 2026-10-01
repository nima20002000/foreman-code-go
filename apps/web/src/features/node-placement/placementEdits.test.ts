import { nativeNode } from '../../shared/mocks/nativeFixtureTypes'
import { sameExecutableWorkflow } from '@graphql/contracts/wave25'
import { fixture } from '../graph/nextDraft/core.cases'
import { draftOperations, mergeAcknowledgement } from '../graph/nextDraft/model'
import { savedPlacementFixture as placement } from './fixtures'

it('classifies a placement edit as executable meaning and keeps per-node saved geometry', () => {
  const context = fixture()
  const graph = { ...context.draft.graph, nodes: context.draft.graph.nodes.map((node, index) => index === 0 ? { ...node, placement, position: { x: 999, y: 999 } } : node) }
  expect(sameExecutableWorkflow(context.draft.graph, graph)).toBe(false)
  const operations = draftOperations(context, graph)
  const operation = operations.find((item) => item.type === 'node.replace_v3')
  expect(operation?.type).toBe('node.replace_v3')
  if (operation?.type === 'node.replace_v3') {
    expect(nativeNode(operation.node).placement).toEqual(placement)
    expect(operation.node.id).toBe('node-0')
    expect(operation.node.position).toEqual(context.draft.graph.nodes[0]?.position)
  }
  expect(graph.nodes[1]).not.toHaveProperty('placement')
})
it('a save acknowledgment cannot overwrite a newer local placement edit', () => {
  const context = fixture()
  const sent = { ...context.draft.graph, nodes: context.draft.graph.nodes.map((node, index) => index === 0 ? { ...node, placement } : node) }
  const newer = { ...sent, nodes: sent.nodes.map((node, index) => index === 0 ? { ...node, placement: { ...placement, locationRevision: '4' } } : node) }
  const merged = mergeAcknowledgement(newer, sent, sent)
  expect(nativeNode(merged.nodes[0])?.placement?.locationRevision).toBe('4')
})
