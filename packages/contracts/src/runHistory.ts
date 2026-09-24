import { z } from 'zod'
import { AgentConfigurationVersionSchema, HarnessExecutionSchema, WorkflowNodeSchema, WorkflowRunSchema, WorkflowVersionSchema } from './index.js'
import { RunCurrentRequestSchema } from './runCurrent.js'

/** An explicit, bounded read of immutable semantics-1 pins and latest results. */
export const RUN_HISTORY_ROUTE = '/api/management/workspaces/:workspaceId/runs/:runId/historical'
export const RUN_HISTORY_MCP_TOOL = 'run_history_get_v1'
export const RunHistoryRequestSchema = RunCurrentRequestSchema
export type RunHistoryRequest = z.infer<typeof RunHistoryRequestSchema>

const version = WorkflowVersionSchema.shape
const node = WorkflowNodeSchema.shape
const configuration = AgentConfigurationVersionSchema.shape
const execution = HarnessExecutionSchema.shape
const run = WorkflowRunSchema.shape

export const RunHistoryResponseSchema = z.object({
  kind: z.literal('legacy-run-history'),
  runId: run.id,
  workspaceId: run.workspaceId,
  workflowId: run.workflowId,
  workflowVersionId: run.workflowVersionId,
  executionSemanticsVersion: z.literal(1),
  version: version.version,
  entryNodeId: version.entryNodeId,
  nodes: z.array(z.object({
    id: node.id, agentId: node.agentId, name: z.string().min(1),
    agentConfigurationVersionId: configuration.id,
  }).strict()).max(10_000),
  edges: z.array(z.object({ id: z.string().min(1), source: node.id, target: node.id }).strict()).max(50_000),
  runResult: z.object({ outcome: z.enum(['succeeded', 'failed', 'canceled']),
    outputPreview: z.string().max(4_000).optional(), outputTruncated: z.boolean().optional() }).strict().optional(),
  /** Agent settings are included only with a scoped agents:read grant. Never includes prompts or skills. */
  agentConfigurations: z.array(z.object({
    id: configuration.id, agentId: configuration.agentId,
    harness: z.enum(['codex', 'opencode']), model: z.string().min(1),
    reasoningEffort: z.string().optional(), sandbox: z.string().optional(),
    serviceTier: z.string().optional(), variant: z.string().optional(),
    nativeAgent: z.string().optional(), thinking: z.boolean().optional(),
  }).strict()).max(10_000),
  latestResults: z.array(z.object({
    id: execution.id, workflowNodeId: execution.workflowNodeId, attempt: execution.attempt,
    state: execution.state, outcome: z.enum(['succeeded', 'failed', 'canceled']).optional(),
    outputPreview: z.string().max(4_000).optional(), outputTruncated: z.boolean().optional(),
  }).strict()).max(10_000),
}).strict().superRefine((value, context) => {
  const nodes = new Set(value.nodes.map((node) => node.id))
  if (!nodes.has(value.entryNodeId) || nodes.size !== value.nodes.length
    || new Set(value.agentConfigurations.map((item) => item.id)).size !== value.agentConfigurations.length
    || new Set(value.latestResults.map((item) => item.workflowNodeId)).size !== value.latestResults.length
    || value.edges.some((edge) => !nodes.has(edge.source) || !nodes.has(edge.target))
    || value.latestResults.some((result) => !nodes.has(result.workflowNodeId))) {
    context.addIssue({ code: 'custom', message: 'Historical topology and results must match the pinned version.' })
  }
})
export type RunHistoryResponse = z.infer<typeof RunHistoryResponseSchema>
