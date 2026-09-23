import { z } from 'zod'
import { HarnessExecutionSchema, WorkflowRunSchema } from './index.js'

/** Additive semantics-1 read, not a graph-v2 snapshot or the full Run detail contract. */
export const RUN_CURRENT_ROUTE = '/api/management/workspaces/:workspaceId/runs/:runId/current'
export const RUN_CURRENT_MCP_TOOL = 'run_current_get_v1'

const run = WorkflowRunSchema.shape
const execution = HarnessExecutionSchema.shape
export const RunCurrentRequestSchema = z.object({
  workspaceId: run.workspaceId,
  workflowId: run.workflowId,
  runId: run.id,
  workflowVersionId: run.workflowVersionId,
  executionSemanticsVersion: z.literal(1),
}).strict()
export type RunCurrentRequest = z.infer<typeof RunCurrentRequestSchema>

export const RunCurrentResponseSchema = z.object({
  kind: z.literal('legacy-run-current'),
  executionSemanticsVersion: z.literal(1),
  run: z.object({
    id: run.id, workspaceId: run.workspaceId, workflowId: run.workflowId,
    workflowVersionId: run.workflowVersionId,
    executionState: run.executionState, outcome: run.outcome, stopCause: run.stopCause,
    createdAt: run.createdAt, startedAt: run.startedAt, finishedAt: run.finishedAt,
  }).strict().superRefine((value, context) => {
    if (value.executionState === 'completed'
      ? value.outcome === 'pending' || !value.finishedAt
      : value.outcome !== 'pending' || value.finishedAt !== undefined) {
      context.addIssue({ code: 'custom', message: 'Lifecycle and outcome must remain distinct persisted facts.' })
    }
  }),
  executions: z.array(z.object({
    id: execution.id, runId: execution.runId, workflowNodeId: execution.workflowNodeId,
    attempt: execution.attempt, state: execution.state,
  }).strict()),
  executionCoverage: z.literal('latest-attempt-per-pinned-node'),
  cleanupPending: z.boolean(),
  // A clean cleanup flag alone cannot certify native/approval/review settlement.
  settlement: z.literal('unconfirmed'),
  history: z.literal('not-included'),
  // Indexed high-water observation, NOT an event count, graph cursor or settlement proof.
  asOfActivitySequence: z.string().regex(/^(0|[1-9][0-9]{0,18})$/)
    .refine((value) => value.length < 19 || value.length === 19 && value <= '9223372036854775807', 'Sequence exceeds PostgreSQL bigint.'),
}).strict().superRefine((value, context) => {
  const ids = new Set<string>()
  const nodes = new Set<string>()
  for (const row of value.executions) {
    if (row.runId !== value.run.id || ids.has(row.id) || nodes.has(row.workflowNodeId)) {
      context.addIssue({ code: 'custom', path: ['executions'], message: 'Current attempts must be unique and belong to this Run.' })
    }
    ids.add(row.id)
    nodes.add(row.workflowNodeId)
  }
})
export type RunCurrentResponse = z.infer<typeof RunCurrentResponseSchema>
