import { z } from 'zod'
import {
  ManagedWorkspaceSchema, ManagementPageInfoSchema, OperatorCapabilitiesSchema,
  ManagementActionSchema,
  WorkspaceListInputSchema, WorkflowListInputSchema,
  AgentListInputSchema, RunListInputSchema,
} from './management/index.js'
import { SavedManagedWorkflowSchema } from './wave25/saved.js'

const detail = z.enum(['compact', 'full']).default('compact')
const limit = z.number().int().min(1).max(100).default(10)

export const OperatorWorkspaceListInputSchema = WorkspaceListInputSchema.extend({ detail, limit })
export const OperatorWorkflowListInputSchema = WorkflowListInputSchema.extend({ detail, limit })
export const OperatorAgentListInputSchema = AgentListInputSchema.extend({ limit })
export const OperatorRunListInputSchema = RunListInputSchema.extend({ limit })

export const WorkspaceSummarySchema = z.object({
  workspace: ManagedWorkspaceSchema.shape.workspace.pick({ id: true, name: true }),
  revision: ManagedWorkspaceSchema.shape.revision,
  archivedAt: ManagedWorkspaceSchema.shape.archivedAt,
  locationRevision: ManagedWorkspaceSchema.shape.locationRevision,
  locationStatus: z.enum(['unconfigured', 'restricted', 'ready', 'unavailable']),
  detailsOmitted: z.literal(true),
}).strict()
export const WorkspaceSummaryPageSchema = z.object({
  detail: z.literal('compact'), items: z.array(WorkspaceSummarySchema), pageInfo: ManagementPageInfoSchema,
}).strict()

export const WorkflowSummarySchema = SavedManagedWorkflowSchema.omit({ workflow: true }).extend({
  workflow: z.object({
    id: SavedManagedWorkflowSchema.shape.workflow.shape.id,
    workspaceId: SavedManagedWorkflowSchema.shape.workflow.shape.workspaceId,
    name: SavedManagedWorkflowSchema.shape.workflow.shape.name,
  }).strict(),
  detailsOmitted: z.literal(true),
}).strict()
export const WorkflowSummaryPageSchema = z.object({
  detail: z.literal('compact'), items: z.array(WorkflowSummarySchema), pageInfo: ManagementPageInfoSchema,
}).strict()

export const OperatorCompactCapabilitiesSchema = OperatorCapabilitiesSchema.omit({ requirements: true }).extend({
  detail: z.literal('compact'),
  tools: z.array(z.string()),
  detailsTool: z.literal('operator_tool_schema_get'),
  fullDetailArguments: z.object({ detail: z.literal('full') }).strict(),
}).strict()

export const OperatorToolSchemaInputSchema = z.object({
  name: z.string().min(1).max(256),
  includeOutputSchema: z.boolean().default(false),
}).strict()
export const OperatorToolSchemaResultSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  annotations: z.record(z.string(), z.unknown()).optional(),
  permissionRequirements: z.object({
    actions: z.array(ManagementActionSchema).optional(), detail: z.string(),
  }).strict(),
}).strict()

/** Operator delivers one JSON text body; other MCP roles may deliver structured data. */
export function decodeMcpToolResult(result: {
  structuredContent?: unknown;
  content?: readonly { type: string; text?: string | undefined }[] | undefined;
}): Record<string, unknown> {
  if (result.structuredContent !== undefined) return result.structuredContent as Record<string, unknown>
  const text = result.content?.find((part) => part.type === 'text' && part.text !== undefined)?.text
  if (text === undefined) throw new Error('The MCP result has no JSON data.')
  return JSON.parse(text) as Record<string, unknown>
}
