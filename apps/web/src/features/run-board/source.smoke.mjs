/** Dependency-free checks of actual production projections plus source fences.
 * Run with Node >=22.16: node --experimental-strip-types --test <this file>.
 * These do NOT execute React, Zod, Vitest, MSW, authorization or browser layout.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { URL } from 'node:url'
import { projectRunBoard, READ_ONLY_FLOW_PROPS } from './model.ts'
import { savedEdgeCurve } from './curve.ts'

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
const snapshot = freeze({
  workspaceId: 'workspace-smoke', workflowId: 'workflow-smoke', runId: 'run-a', kind: 'available',
  workflowVersionId: 'version-old', capturedAt: '2026-09-20T08:00:00.000Z',
  nodes: [
    { id: 'x', agentId: 'agent-x', name: 'Old X', agentConfigurationVersionId: 'config-x-old',
      position: { x: -80, y: 40 }, size: { width: 180, height: 120 } },
    { id: 'y', agentId: 'removed-y', name: 'Y', agentConfigurationVersionId: 'config-y-old',
      position: { x: 500, y: 230 }, size: { width: 260, height: 160 } },
  ],
  edges: [
    { id: 'xy', source: 'x', target: 'y', sourceHandle: 'bottom', targetHandle: 'top', kind: 'execution', label: 'Saved work', maxWorkHandoffsPerRun: 3 },
    { id: 'approval', source: 'x', target: 'y', sourceHandle: 'bottom', targetHandle: 'top', kind: 'approval' },
    { id: 'reverse', source: 'y', target: 'x', kind: 'approval' },
  ],
})

test('projection retains removed Y, exact names, version references and geometry', () => {
  const { nodes } = projectRunBoard(snapshot)
  assert.deepEqual(nodes.map((node) => node.id), ['x', 'y'])
  nodes.forEach((node, index) => {
    const source = snapshot.nodes[index]
    assert.equal(node.data.snapshot, source)
    assert.deepEqual(node.position, source.position)
    assert.notEqual(node.position, source.position)
    assert.deepEqual(node.style, { width: source.size.width, height: source.size.height })
    assert.equal(node.initialWidth, source.size.width)
    assert.equal(node.initialHeight, source.size.height)
    assert.ok(node.domAttributes.title.includes(source.agentConfigurationVersionId))
  })
})
test('B lacks Y; output geometry mutations never mutate frozen snapshot A', () => {
  const before = JSON.stringify(snapshot)
  const a = projectRunBoard(snapshot)
  a.nodes[0].position.x = 2000
  a.nodes[1].style.height = 999
  a.nodes.pop(); a.edges.pop()
  assert.equal(JSON.stringify(snapshot), before)
  const b = projectRunBoard({ ...snapshot, runId: 'run-b', nodes: [snapshot.nodes[0]], edges: [] })
  assert.deepEqual(b.nodes.map((node) => node.id), ['x'])
  assert.deepEqual(b.edges, [])
})
test('all relationships stay distinct with saved handles, kinds, labels and policy', () => {
  const { edges } = projectRunBoard(snapshot)
  assert.deepEqual(edges.map((edge) => edge.id), ['xy', 'approval', 'reverse'])
  assert.deepEqual(edges.map((edge) => [edge.source, edge.target]), [['x', 'y'], ['x', 'y'], ['y', 'x']])
  assert.equal(edges[0].sourceHandle, 'bottom'); assert.equal(edges[0].targetHandle, 'top')
  assert.equal(edges[0].data.snapshot.maxWorkHandoffsPerRun, 3)
  assert.equal(edges[0].data.snapshot.label, 'Saved work')
  assert.equal(edges[2].sourceHandle, 'right'); assert.equal(edges[2].targetHandle, 'left')
  assert.equal(new Set(edges.map((edge) => edge.data.lane * (edge.source < edge.target ? 1 : -1))).size, 3)
  assert.equal(edges[1].data.snapshot, snapshot.edges[1])
})
test('canvas and each object disallow every topology mutation', () => {
  for (const key of ['nodesDraggable', 'nodesConnectable', 'edgesReconnectable', 'elementsSelectable',
    'selectNodesOnDrag', 'selectionOnDrag', 'connectOnClick']) assert.equal(READ_ONLY_FLOW_PROPS[key], false, key)
  for (const key of ['deleteKeyCode', 'selectionKeyCode', 'multiSelectionKeyCode']) assert.equal(READ_ONLY_FLOW_PROPS[key], null, key)
  assert.equal(READ_ONLY_FLOW_PROPS.disableKeyboardA11y, true)
  const { nodes, edges } = projectRunBoard(snapshot)
  for (const node of nodes) for (const key of ['draggable', 'connectable', 'selectable', 'deletable']) assert.equal(node[key], false, key)
  for (const edge of edges) for (const key of ['reconnectable', 'selectable', 'deletable']) assert.equal(edge[key], false, key)
})
test('curve honors all saved handle sides/endpoints and has finite geometry', () => {
  for (const sourcePosition of ['top', 'right', 'bottom', 'left']) {
    for (const targetPosition of ['top', 'right', 'bottom', 'left']) {
      const curves = [-2, 0, 2].map((lane) => savedEdgeCurve({ sourceX: 40, sourceY: 20, targetX: 600, targetY: 300,
        sourcePosition, targetPosition, lane, loop: false }))
      assert.equal(new Set(curves.map((curve) => curve.path)).size, 3)
      for (const curve of curves) {
        assert.match(curve.path, /^M 40,20 C /); assert.match(curve.path, / 600,300$/)
        assert.ok(Object.values(curve.mid).every(Number.isFinite))
      }
    }
  }
})
test('self/coincident edges have finite loops, not a NaN path', () => {
  const result = savedEdgeCurve({ sourceX: 0, sourceY: 0, targetX: 0, targetY: 0,
    sourcePosition: 'top', targetPosition: 'top', lane: 0, loop: true })
  assert.doesNotMatch(result.path, /NaN|Infinity/)
  assert.ok(Object.values(result.mid).every(Number.isFinite))
  assert.notEqual(result.mid.y, 0)
})
const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
test('production sources cannot access authoring state, live agents or write clients', () => {
  for (const file of ['RunBoard.tsx', 'RunBoardSlot.tsx', 'RunBoardCanvas.tsx', 'model.ts', 'curve.ts']) {
    assert.doesNotMatch(source(file), /useGraphDraftStore|useGraphPresentation|useMutation|setQueryData|StartControls|PersistedWorkflowBoundary|readPinnedAgentVersion/)
  }
  const canvas = source('RunBoardCanvas.tsx')
  assert.match(canvas, /<ReactFlowProvider>/)
  assert.match(canvas, /showInteractive=\{false\}/)
  assert.doesNotMatch(canvas, /onNodesChange=|onEdgesChange=|onConnect=|onReconnect=|onNodeDrag/)
  assert.match(canvas, /AgentNodeView/); assert.match(canvas, /SignalEdgeShape/)
})
test('source fences: shared generation query, keyed history canvas, retained editor child', () => {
  const board = source('RunBoard.tsx'), slot = source('RunBoardSlot.tsx')
  assert.match(board, /useSelectedRunSnapshot\(selection\)/)
  assert.match(board, /selection\.isCurrent\(selection\.generation\)/)
  assert.match(board, /RunBoardCanvas key=\{selection\.generation\.id\}/)
  assert.match(board, /snapshot\?\.kind === 'unavailable'.*Snapshot unavailable/)
  assert.match(slot, /hidden=\{!current\} inert=\{!current\}>\{children\}<\/div>/)
  assert.doesNotMatch(slot, /key=|useEffect|useState/)
})
