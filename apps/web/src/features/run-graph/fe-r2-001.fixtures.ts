import type { RunCurrentResponse } from '@graphql/contracts/run-current'
import type { RunGraphScope } from '@graphql/contracts/wave25'

export const legacyScope: RunGraphScope = { workspaceId: 'ws-fe-r2', workflowId: 'wf-fe-r2', runId: 'run-fe-r2',
  workflowVersionId: 'version-fe-r2', executionSemanticsVersion: 1 }
export function legacyCurrent(sequence = '10', cleanupPending = false): RunCurrentResponse {
  return { kind: 'legacy-run-current', executionSemanticsVersion: 1,
    run: { id: legacyScope.runId, workspaceId: legacyScope.workspaceId, workflowId: legacyScope.workflowId,
      workflowVersionId: legacyScope.workflowVersionId, executionState: 'running', outcome: 'pending', createdAt: '2026-09-22T00:00:00.000Z' },
    executions: [{ id: 'execution-fe-r2', runId: legacyScope.runId, workflowNodeId: 'node-fe-r2', attempt: 3, state: 'running' }],
    executionCoverage: 'latest-attempt-per-pinned-node', cleanupPending, settlement: 'unconfirmed',
    history: 'not-included', asOfActivitySequence: sequence }
}
