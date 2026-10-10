import { RunBoardSnapshotSchema, type RunBoardSnapshotGetResult } from '@foreman-code/contracts/run-snapshots'
import { makeCurrentWorkflowFixture, RunVersionDetailSchema } from '@foreman-code/contracts/wave25'
import type { RunsSelectorScope } from '../runs-selector/types'
import type { AvailableRunBoardSnapshot } from './model'

export const scope = { workspaceId: 'workspace-snap', workflowId: 'workflow-snap' }
export const runA = RunBoardSnapshotSchema.parse({
  ...scope, runId: 'run-a', kind: 'available', workflowVersionId: 'version-a', capturedAt: '2026-09-20T08:00:00.000Z',
  nodes: [
    { id: 'node-x', agentId: 'agent-x', name: 'X before rename', agentConfigurationVersionId: 'config-x-old',
      position: { x: -80, y: 40 }, size: { width: 180, height: 120 } },
    { id: 'node-y', agentId: 'agent-y', name: 'Y', agentConfigurationVersionId: 'config-y-old',
      position: { x: 500, y: 230 }, size: { width: 260, height: 160 } },
    { id: 'node-z', agentId: 'agent-z', name: 'Z', agentConfigurationVersionId: 'config-z-old',
      position: { x: 900, y: 40 }, size: { width: 180, height: 200 } },
  ],
  edges: [
    { id: 'edge-xy', source: 'node-x', target: 'node-y', kind: 'execution', label: 'Old handoff',
      sourceHandle: 'bottom', targetHandle: 'top', maxWorkHandoffsPerRun: 3, workRequestDirection: 'source_to_target' },
    { id: 'approval-xy', source: 'node-x', target: 'node-y', kind: 'approval', label: 'Old approval',
      sourceHandle: 'bottom', targetHandle: 'top' },
    { id: 'edge-yz', source: 'node-y', target: 'node-z', kind: 'execution' },
  ],
}) as AvailableRunBoardSnapshot
export const runB = RunBoardSnapshotSchema.parse({
  ...scope, runId: 'run-b', kind: 'available', workflowVersionId: 'version-b', capturedAt: '2026-09-21T08:00:00.000Z',
  nodes: [
    { ...runA.nodes[0]!, name: 'X in B', agentConfigurationVersionId: 'config-x-b', position: { x: 100, y: 300 } },
    { ...runA.nodes[2]!, position: { x: 400, y: -120 } },
  ],
  edges: [{ id: 'edge-xz', source: 'node-x', target: 'node-z', kind: 'execution' }],
}) as AvailableRunBoardSnapshot

export function reply(runId: string, target: RunsSelectorScope = scope): RunBoardSnapshotGetResult {
  return { snapshot: RunBoardSnapshotSchema.parse(runId === 'legacy'
    ? { ...target, runId, kind: 'unavailable', reason: 'legacy_run' }
    : { ...(runId === 'run-b' ? runB : runA), ...target, runId }) }
}
export function versionReply(snapshot: RunBoardSnapshotGetResult['snapshot']) {
  if (snapshot.kind !== 'available') throw new Error('The saved version fixture requires an available snapshot.')
  const { workspaceId, workflowId, runId } = snapshot
  const { version } = makeCurrentWorkflowFixture('saved-run-board', 'single')
  const nodes = snapshot.nodes.map(node => {
    if (node.kind === 'job') throw new Error('The saved version fixture supports agent snapshots.')
    return node
  })
  const entryNodeId = snapshot.nodes[0]!.id
  return RunVersionDetailSchema.parse({
    scope: { workspaceId, workflowId, runId, workflowVersionId: snapshot.workflowVersionId, executionSemanticsVersion: 3 },
    version: {
      ...version,
      id: snapshot.workflowVersionId,
      workspaceId,
      workflowId,
      entryNodeId,
      createdAt: snapshot.capturedAt,
      agentConfigurationVersionIds: Object.fromEntries(nodes.map(node =>
        [node.agentId, node.agentConfigurationVersionId])),
      definition: {
        ...version.definition,
        id: workflowId,
        workspaceId,
        entryNodeId,
        nodes: nodes.map(node => ({
          id: node.id, agentId: node.agentId, name: node.name, position: node.position,
          width: node.size.width, height: node.size.height,
        })),
        edges: snapshot.edges,
        executionPolicy: { maxParallelism: 1, maxNodeExecutions: snapshot.nodes.length },
      },
    },
  })
}
export function runsUrl(runId: string | null, target: RunsSelectorScope = scope) {
  const search = new URLSearchParams({ workflowId: target.workflowId })
  if (runId !== null) search.set('selectedRunId', runId)
  return `/workspaces/${encodeURIComponent(target.workspaceId)}?${search}`
}
export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
