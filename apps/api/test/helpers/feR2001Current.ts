import type { RunCurrentRequest, RunCurrentResponse } from '@graphql/contracts/run-current'
import type { ManagementPrincipal } from '@graphql/contracts/management'

export const currentScope: RunCurrentRequest = { workspaceId: 'ws-fe-r2', workflowId: 'wf-fe-r2',
  runId: 'run-fe-r2', workflowVersionId: 'version-fe-r2', executionSemanticsVersion: 1 }
export function currentRow(sequence = '10', cleanupPending = false) {
  const run: RunCurrentResponse['run'] = { id: currentScope.runId, workspaceId: currentScope.workspaceId,
    workflowId: currentScope.workflowId, workflowVersionId: currentScope.workflowVersionId,
    executionState: 'running', outcome: 'pending', createdAt: '2026-09-22T00:00:00.000Z' }
  return { run, sequence, cleanup_pending: cleanupPending, run_semantics: 1, version_semantics: 1, version_pin: 1, definition_semantics: 1,
    version_id: currentScope.workflowVersionId, version_workspace_id: currentScope.workspaceId,
    version_workflow_id: currentScope.workflowId, definition_id: currentScope.workflowId,
    definition_workspace_id: currentScope.workspaceId, node_ids: ['node-fe-r2'], nodes_valid: true, identities_valid: true,
    executions: [{ id: 'execution-fe-r2', runId: currentScope.runId, workflowNodeId: 'node-fe-r2', attempt: 3, state: 'running' }] }
}
export function currentPrincipal(granted = true): ManagementPrincipal {
  return { id: 'operator-fe-r2', name: 'FE-R2-001 test operator', audience: 'operator',
    expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null,
    grants: granted ? [{ actions: ['runs:read'], scope: { workspaceIds: [currentScope.workspaceId],
      workflowIds: [currentScope.workflowId], runIds: [currentScope.runId] } }] : [] }
}
