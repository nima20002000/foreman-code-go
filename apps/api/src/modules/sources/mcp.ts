import type { McpServer } from '@modelcontextprotocol/server'
import type { OperatorRequestContext } from '../../mcp/operator/types.js'
import { operatorToolAvailable } from '../../mcp/operator/availability.js'
import { invokeOperatorTool } from '../../mcp/operator/invoke.js'
import {
  SourceApproveInputSchema, SourceApproveResultSchema, SourceGetInputSchema, ApprovedSourceSchema,
  SourceRootBindInputSchema, SourceRootBindResultSchema,
  SourceRootGetInputSchema, SourceRootRecordSchema, SourceRootListInputSchema, SourceRootListResultSchema,
  SourcePreparationGetInputSchema, SourcePreparationSchema, SourcePreparationReconcileInputSchema, SourcePreparationReconcileResultSchema,
} from '@foreman-code/contracts/source-admission'
import type { PostgresSourceService } from './service.js'
import { OperatorSourceListInputSchema, OperatorSourceListResultSchema, SourceSummarySchema } from '@foreman-code/contracts/operator-mcp'

export function registerSourceTools(server: McpServer, context: OperatorRequestContext & { services: { sources?: PostgresSourceService } }): void {
  const service = context.services.sources
  if (!service) return
  const annotations = (write: boolean) => ({ readOnlyHint: !write, destructiveHint: false, idempotentHint: true, openWorldHint: false })
  if (operatorToolAvailable(context, 'source_preparation_get')) server.registerTool('source_preparation_get', { description: 'Read a Job or workflow source preparation reservation and its reconciliation evidence using operationId. Job preparations also accept the original Start commandId as startCommandId. Requires sources:read and source_roots:read in the workspace. Missing or ambiguous commands fail without substitution. No filesystem probe or caller closure assertion is accepted.',
    inputSchema: SourcePreparationGetInputSchema, outputSchema: SourcePreparationSchema, annotations: annotations(false) }, input => invokeOperatorTool(context, 'source_preparation_get', () => service.preparationGet(context.principal, 'mcp', input)))
  if (operatorToolAvailable(context, 'source_preparation_reconcile')) server.registerTool('source_preparation_reconcile', { description: 'Reconcile a failed Job preparation, source/native resources of a stopped workflow, or retained source of an admitted Job with confirmed terminal process closure and settled publication. Requires sources:reconcile, sources:read and source_roots:read; admitted Job recovery also requires jobs:cancel. Remote cleanup verifies the exact original worker owner and kernel boundaries. Each admitted Job recovery has a fresh bounded cleanup authorization and preserves saved execution deadlines. Archives only the original claim and retains evidence. Retry the same commandId after an unknown acknowledgment. Paths, PIDs, force flags and caller closure assertions are refused.',
    inputSchema: SourcePreparationReconcileInputSchema, outputSchema: SourcePreparationReconcileResultSchema, annotations: annotations(true) }, input => invokeOperatorTool(context, 'source_preparation_reconcile', () => service.preparationReconcile(context.principal, 'mcp', input)))
  if (operatorToolAvailable(context, 'source_list')) server.registerTool('source_list', {
    description: 'List approved workspace source snapshots and availability. Defaults to 10 compact summaries with source pins, Git identity and inventory counts. Pass detail: "full" for file entries and deletions, or source_get for one manifest. Follow nextSnapshotId using afterSnapshotId. No filesystem probe or Run/Agent is required.',
    inputSchema: OperatorSourceListInputSchema, outputSchema: OperatorSourceListResultSchema,
    annotations: annotations(false),
  }, input => invokeOperatorTool(context, 'source_list', async () => {
    const { detail, ...request } = input
    const result = await service.list(context.principal, 'mcp', request)
    if (detail === 'full') return result
    return { ...result, detail: 'compact', items: result.items.map(item => {
      const { entries, deletions, ...manifest } = item.manifest
      void entries
      void deletions
      return SourceSummarySchema.parse({ ...item, manifest, detailsOmitted: true })
    }) }
  }))
  if (operatorToolAvailable(context, 'source_get')) server.registerTool('source_get', { description: 'Read one exact approvedSourceId/snapshotId/manifestDigest in its workspace. Automatically released bytes fail with SOURCE_UNAVAILABLE; a newer snapshot is never substituted.',
    inputSchema: SourceGetInputSchema, outputSchema: ApprovedSourceSchema, annotations: annotations(false) }, input => invokeOperatorTool(context, 'source_get', () => service.get(context.principal, 'mcp', input)))
  if (operatorToolAvailable(context, 'source_approve')) server.registerTool('source_approve', { description: 'Approve and capture an exact Git commit using either approvedPaths listing every tracked file, or approveTrackedTree: true with approvedPaths omitted to explicitly approve its complete tracked tree. Both modes reject sensitive paths/content and enforce executable policy, entry/byte limits and an exact manifest. The choice and resolved inventory are audited. Capture runs from the workspace\'s persisted canonical location. Captures the configured repository and approved commit/tree objects so unpublished commits can reach other computers. Requires source approval/read and location read grants; no path, Run, Agent, hooks or credentials are accepted. Unused snapshots expire automatically after their retention window; qualified profiles and active work retain their source. Successful commandId retries preserve the exact snapshot, or fail with SOURCE_UNAVAILABLE after release. SOURCE_CAPTURE_TIMEOUT is retryable with a new explicit commandId; a failed command never resurrects its quarantined snapshot.',
    inputSchema: SourceApproveInputSchema, outputSchema: SourceApproveResultSchema, annotations: annotations(true) }, input => invokeOperatorTool(context, 'source_approve', () => service.approve(context.principal, 'mcp', input)))
  if (operatorToolAvailable(context, 'source_root_list')) server.registerTool('source_root_list', { description: 'Read permitted persisted root bindings, including their canonical paths, for this workspace. Requires sources:read, source_roots:read and workspace_locations:read. This metadata read does not probe a host path or grant native execution or writes.',
    inputSchema: SourceRootListInputSchema, outputSchema: SourceRootListResultSchema, annotations: annotations(false) }, input => invokeOperatorTool(context, 'source_root_list', () => service.rootList(context.principal, 'mcp', input)))
  if (operatorToolAvailable(context, 'source_root_get')) server.registerTool('source_root_get', { description: 'Read one authorized workspace rootId/bindingRevision, its canonical path and source pins. Requires sources:read, source_roots:read and workspace_locations:read. A newer binding is never substituted.',
    inputSchema: SourceRootGetInputSchema, outputSchema: SourceRootRecordSchema, annotations: annotations(false) }, input => invokeOperatorTool(context, 'source_root_get', () => service.rootGet(context.principal, 'mcp', input)))
  if (operatorToolAvailable(context, 'source_root_bind')) server.registerTool('source_root_bind', { description: 'Revision-check and bind a retained source to an existing permitted host/root policy. Resolve workspace/host ownership before attestation. No caller filesystem path or manufactured Run/Agent is accepted; requested access cannot exceed root/harness policy.',
    inputSchema: SourceRootBindInputSchema, outputSchema: SourceRootBindResultSchema, annotations: annotations(true) }, input => invokeOperatorTool(context, 'source_root_bind', () => service.bindRoot(context.principal, 'mcp', input)))
}
