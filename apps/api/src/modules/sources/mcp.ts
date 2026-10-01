import type { McpServer } from '@modelcontextprotocol/server'
import type { OperatorRequestContext } from '../../mcp/operator/types.js'
import { operatorToolAvailable } from '../../mcp/operator/availability.js'
import { invokeOperatorTool } from '../../mcp/operator/invoke.js'
import {
  SourceApproveInputSchema, SourceApproveResultSchema, SourceGetInputSchema, ApprovedSourceSchema,
  SourceListInputSchema, SourceListResultSchema, SourceRootBindInputSchema, SourceRootBindResultSchema,
  SourceRootGetInputSchema, SourceRootRecordSchema, SourceRootListInputSchema, SourceRootListResultSchema,
} from '@graphql/contracts/source-admission'
import type { PostgresSourceService } from './service.js'

export function registerSourceTools(server: McpServer, context: OperatorRequestContext & { services: { sources?: PostgresSourceService } }): void {
  const service = context.services.sources
  if (!service) return
  const annotations = (write: boolean) => ({ readOnlyHint: !write, destructiveHint: false, idempotentHint: true, openWorldHint: false })
  if (operatorToolAvailable(context, 'source_list')) server.registerTool('source_list', { description: 'List retained or explicitly unavailable immutable approved workspace source snapshots. No filesystem probe, latest substitution or Run/Agent is required.',
    inputSchema: SourceListInputSchema, outputSchema: SourceListResultSchema, annotations: annotations(false) }, input => invokeOperatorTool(context, 'source_list', () => service.list(context.principal, 'mcp', input)))
  if (operatorToolAvailable(context, 'source_get')) server.registerTool('source_get', { description: 'Read one exact approvedSourceId/snapshotId/manifestDigest in its workspace. Unavailable bytes fail; a newer snapshot is never substituted.',
    inputSchema: SourceGetInputSchema, outputSchema: ApprovedSourceSchema, annotations: annotations(false) }, input => invokeOperatorTool(context, 'source_get', () => service.get(context.principal, 'mcp', input)))
  if (operatorToolAvailable(context, 'source_approve')) server.registerTool('source_approve', { description: 'Approve and capture an exact Git commit and every explicit inclusion from the workspace\'s persisted canonical location. Requires source approval/read and location read grants; no path, Run, Agent, hooks or credentials are accepted. commandId retries preserve the exact snapshot.',
    inputSchema: SourceApproveInputSchema, outputSchema: SourceApproveResultSchema, annotations: annotations(true) }, input => invokeOperatorTool(context, 'source_approve', () => service.approve(context.principal, 'mcp', input)))
  if (operatorToolAvailable(context, 'source_root_list')) server.registerTool('source_root_list', { description: 'Read permitted persisted root binding metadata for this workspace. Metadata-only read neither probes a host path nor grants native execution or writes.',
    inputSchema: SourceRootListInputSchema, outputSchema: SourceRootListResultSchema, annotations: annotations(false) }, input => invokeOperatorTool(context, 'source_root_list', () => service.rootList(context.principal, 'mcp', input)))
  if (operatorToolAvailable(context, 'source_root_get')) server.registerTool('source_root_get', { description: 'Read back one exact authorized workspace rootId/bindingRevision and source pins; never look up a newer binding.',
    inputSchema: SourceRootGetInputSchema, outputSchema: SourceRootRecordSchema, annotations: annotations(false) }, input => invokeOperatorTool(context, 'source_root_get', () => service.rootGet(context.principal, 'mcp', input)))
  if (operatorToolAvailable(context, 'source_root_bind')) server.registerTool('source_root_bind', { description: 'Revision-check and bind a retained source to an existing permitted host/root policy. Resolve workspace/host ownership before attestation. No caller filesystem path or manufactured Run/Agent is accepted; requested access cannot exceed root/harness policy.',
    inputSchema: SourceRootBindInputSchema, outputSchema: SourceRootBindResultSchema, annotations: annotations(true) }, input => invokeOperatorTool(context, 'source_root_bind', () => service.bindRoot(context.principal, 'mcp', input)))
}
