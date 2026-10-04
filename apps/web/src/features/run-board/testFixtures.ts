import { RunBoardSnapshotSchema, type RunBoardSnapshotGetResult } from '@foreman-code/contracts/run-snapshots'
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
