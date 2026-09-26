import type pg from 'pg'
import { z } from 'zod'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import {
  RUN_INSPECTION_LIMITS, RunAcceptedInputValueSchema, RunExecutionBindingSchema,
  RunExecutionBindingsListInputSchema, RunExecutionBindingsPageSchema,
  RunExecutionDetailSchema, RunExecutionGetInputSchema, RunExecutionSummarySchema,
  RunExecutionsListInputSchema, RunExecutionsPageSchema, RunInspectionRunSchema,
  RunVersionDetailSchema, RunVersionGetInputSchema, RepeatOccurrenceIdentityV1Schema,
  canonicalGraphJson,
  type RunExecutionBindingsPage, type RunExecutionDetail, type RunExecutionSummary,
  type RunExecutionsPage, type RunVersionDetail,
} from '@graphql/contracts/wave25'
import { requireAuthorization } from '../access/policy.js'
import { DomainError } from '../errors.js'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import { withCurrentRunRead } from './currentRead.js'
import type { AcceptedRepeatRunSnapshot } from './repeatStartRead.js'
import {
  readRepeatAcceptedResultLocked, readRepeatDecision, readRepeatExecutionLocked,
  type StoredRepeatExecution,
} from './repeatPostgres.js'
import {
  assertRepeatRef, repeatDigest, repeatExecutionIdentity, repeatId, repeatSlotId, sameRepeatValue,
  type RepeatScope,
} from './repeatResolution.js'
import { INSPECTION_OCCURRENCE_COLUMNS, inspectionExecutionsQuery } from './inspectionPageQuery.js'
import {
  decodeBindingPageCursor, decodeExecutionPageCursor, encodeBindingPageCursor, encodeExecutionPageCursor,
} from './inspectionCursor.js'

function evidence(value: unknown): asserts value {
  if (!value) throw new DomainError('RUN_INSPECTION_EVIDENCE_CONFLICT',
    'The inspection conflicts with its exact persisted scope or accepted evidence.', 409)
}
function scopeOf({ run }: AcceptedRepeatRunSnapshot): RepeatScope {
  return { workspaceId: run.workspaceId, workflowId: run.workflowId, runId: run.id,
    workflowVersionId: run.workflowVersionId, executionSemanticsVersion: 3 }
}
function runSummary(snapshot: AcceptedRepeatRunSnapshot) {
  const { run } = snapshot
  return RunInspectionRunSchema.parse({ ...scopeOf(snapshot), executionState: run.executionState, outcome: run.outcome,
    createdAt: run.createdAt, ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
    ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
    ...(run.stopCause === undefined ? {} : { stopCause: run.stopCause }), cleanupPending: snapshot.cleanupPending })
}
function summaryOf({ execution, ref, accepted }: StoredRepeatExecution): RunExecutionSummary {
  return RunExecutionSummarySchema.parse({ ...repeatExecutionIdentity(execution), state: execution.state,
    createdAt: execution.createdAt, ...(execution.startedAt === undefined ? {} : { startedAt: execution.startedAt }),
    ...(execution.finishedAt === undefined ? {} : { finishedAt: execution.finishedAt }),
    ...(ref.occurrence ? { occurrence: ref.occurrence } : {}), acceptedResultAvailable: accepted })
}
function bounded<T>(value: T): T {
  try { canonicalGraphJson(value, RUN_INSPECTION_LIMITS.responseBytes) }
  catch { throw new DomainError('RUN_INSPECTION_TOO_LARGE', 'The exact inspection exceeds its response bound; it was not truncated.', 409) }
  return value
}

interface OccurrenceRow {
  occurrence_id: string | null; occurrence_run_id: string | null; occurrence_workspace_id: string | null;
  occurrence_workflow_id: string | null; occurrence_version_id: string | null;
  occurrence_block_id: string | null; occurrence_index: number | null; occurrence_identity: unknown;
}

function occurrenceOf(row: OccurrenceRow, snapshot: AcceptedRepeatRunSnapshot) {
  const identity = RepeatOccurrenceIdentityV1Schema.parse(row.occurrence_identity)
  evidence(sameRepeatValue(identity.scope, scopeOf(snapshot)) && identity.occurrenceId === row.occurrence_id
    && identity.blockId === row.occurrence_block_id && identity.occurrenceIndex === row.occurrence_index
    && row.occurrence_run_id === snapshot.run.id && row.occurrence_workspace_id === snapshot.run.workspaceId
    && row.occurrence_workflow_id === snapshot.run.workflowId && row.occurrence_version_id === snapshot.run.workflowVersionId)
  const block = snapshot.version.definition.repeat?.blocks.find((item) => item.id === identity.blockId)
  evidence(block && identity.occurrenceIndex <= block.maxOccurrences)
  return identity
}
interface ExecutionRow extends OccurrenceRow {
  id: string; run_id: string; workflow_node_id: string; agent_id: string; attempt: number;
  repeat_occurrence_id: string | null; accepted: boolean; summary: unknown; reported_outcome: string | null;
  page_created_at: string; identity: unknown; identity_run_id: string | null;
  identity_occurrence_id: string | null; technical_attempt: number | null;
  slot_id: string | null; slot_run_id: string | null; slot_node_id: string | null; slot_occurrence_id: string | null;
}
function rowSummary(row: ExecutionRow, snapshot: AcceptedRepeatRunSnapshot): RunExecutionSummary {
  const summary = RunExecutionSummarySchema.parse(row.summary)
  const occurrence = row.repeat_occurrence_id === null ? null : occurrenceOf(row, snapshot)
  const ref = { nodeId: summary.workflowNodeId, occurrence }, scope = scopeOf(snapshot)
  assertRepeatRef(snapshot.version, scope, ref)
  const node = snapshot.version.definition.nodes.find((item) => item.id === ref.nodeId)!
  const identity = { executionId: summary.executionId, workflowNodeId: summary.workflowNodeId, agentId: summary.agentId,
    agentConfigurationVersionId: summary.agentConfigurationVersionId, attempt: summary.attempt }
  evidence(row.run_id === scope.runId && row.id === identity.executionId && row.workflow_node_id === identity.workflowNodeId
    && row.agent_id === identity.agentId && row.attempt === identity.attempt && node.agentId === identity.agentId
    && snapshot.version.agentConfigurationVersionIds[identity.agentId] === identity.agentConfigurationVersionId
    && row.identity_run_id === scope.runId && row.slot_run_id === scope.runId && row.slot_node_id === ref.nodeId
    && row.slot_id === repeatSlotId(scope.runId, ref) && row.technical_attempt === identity.attempt
    && row.slot_occurrence_id === row.repeat_occurrence_id && row.identity_occurrence_id === row.repeat_occurrence_id
    && (occurrence?.occurrenceId ?? null) === row.repeat_occurrence_id
    && sameRepeatValue(row.identity, occurrence ? { ...identity, occurrence } : identity)
    && summary.acceptedResultAvailable === row.accepted
    && (summary.state === 'completed'
      ? summary.finishedAt !== undefined && ['succeeded', 'failed', 'canceled'].includes(row.reported_outcome ?? '')
      : summary.finishedAt === undefined && row.reported_outcome === null)
    && (!row.accepted || (summary.state === 'completed' && row.reported_outcome === 'succeeded')))
  return { ...summary, ...(occurrence ? { occurrence } : {}) }
}

/** ONE read-only service for management HTTP and authenticated Operator MCP.
 * Admission's immutable readers and exact receipt readers are reused, not a
 * second repository/engine, moving-head projection or lifetime-sized detail. */
export class RunInspectionService {
  constructor(private readonly pool: pg.Pool) {}

  private async read<T>(principal: ManagementPrincipal, input: { workspaceId: string; runId: string },
    work: (sql: GraphTransactionSql, snapshot: AcceptedRepeatRunSnapshot, live: ManagementPrincipal) => Promise<T>): Promise<T> {
    try {
      return await withCurrentRunRead(this.pool, principal, input.workspaceId, input.runId, 'runs:read', work)
    } catch (error) {
      // Do not serialize parser fragments of private persisted input/native data.
      if (error instanceof z.ZodError || error instanceof SyntaxError) throw new DomainError(
        'RUN_INSPECTION_EVIDENCE_CONFLICT', 'Persisted inspection evidence is invalid or unavailable.', 409)
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
      if (['ECONNREFUSED', 'ECONNRESET', '57P01', '57P02', '57P03', '57014', '55P03', '53300', '42P01', '42703'].includes(code) || code.startsWith('08')) {
        throw new DomainError('RUN_INSPECTION_UNAVAILABLE', 'The Run inspection store is unavailable.', 503)
      }
      throw error
    }
  }

  async executions(principal: ManagementPrincipal, raw: unknown): Promise<RunExecutionsPage> {
    const input = RunExecutionsListInputSchema.parse(raw)
    return this.read(principal, input, async (sql, snapshot) => {
      const scope = scopeOf(snapshot)
      if (input.workflowNodeId && !snapshot.version.definition.nodes.some((node) => node.id === input.workflowNodeId)) {
        throw new DomainError('WORKFLOW_NODE_NOT_FOUND', 'The node is not in this Run\'s pinned version.', 404)
      }
      if (input.occurrenceId) {
        const found = (await sql.query<OccurrenceRow>(`select ${INSPECTION_OCCURRENCE_COLUMNS} from run_repeat_occurrences o
          where o.run_id=$1 and o.occurrence_id=$2`, [input.runId, input.occurrenceId])).rows[0]
        if (!found) throw new DomainError('RUN_OCCURRENCE_NOT_FOUND', 'The occurrence was not found in this Run.', 404)
        const occurrence = occurrenceOf(found, snapshot)
        if (input.workflowNodeId && !snapshot.version.definition.repeat?.blocks.find((block) => block.id === occurrence.blockId)
          ?.nodeIds.includes(input.workflowNodeId)) throw new DomainError('WORKFLOW_NODE_NOT_FOUND', 'The node is not in this occurrence.', 404)
      }
      const cursorScope = [scope, input.workflowNodeId ?? null, input.occurrenceId ?? null]
      const after = decodeExecutionPageCursor(cursorScope, input.cursor)
      // One bounded metadata query. In particular, do not select e.record, input_json,
      // results, native events or the Run's entire execution/occurrence history.
      const query = inspectionExecutionsQuery(input, after)
      const rows = (await sql.query<ExecutionRow>(query.text, query.values)).rows
      const summaries = rows.map((row) => rowSummary(row, snapshot))
      const last = rows[Math.min(rows.length, input.limit) - 1]
      return bounded(RunExecutionsPageSchema.parse({ run: runSummary(snapshot), items: summaries.slice(0, input.limit),
        pageInfo: { nextCursor: rows.length > input.limit && last ? encodeExecutionPageCursor(cursorScope,
          { createdAt: last.page_created_at, executionId: last.id }) : null } }))
    })
  }

  private async execution(sql: GraphTransactionSql, snapshot: AcceptedRepeatRunSnapshot, executionId: string) {
    const found = await sql.query('select id from harness_executions where id=$1 and run_id=$2', [executionId, snapshot.run.id])
    if (found.rows.length !== 1) throw new DomainError('RUN_EXECUTION_NOT_FOUND', 'The execution was not found in this Run.', 404)
    return readRepeatExecutionLocked(sql, snapshot, executionId)
  }

  async executionDetail(principal: ManagementPrincipal, raw: unknown): Promise<RunExecutionDetail> {
    const input = RunExecutionGetInputSchema.parse(raw)
    return this.read(principal, input, async (sql, snapshot) => {
      const stored = await this.execution(sql, snapshot, input.executionId)
      const accepted = await readRepeatAcceptedResultLocked(sql, snapshot, input.executionId)
      evidence(stored.accepted === (accepted !== undefined))
      return bounded(RunExecutionDetailSchema.parse({ run: runSummary(snapshot), execution: summaryOf(stored),
        acceptedInput: { digest: stored.inputDigest, value: stored.input },
        acceptedResult: accepted === undefined ? { status: 'not_accepted' }
          : { status: 'accepted', digest: repeatDigest(accepted, RUN_INSPECTION_LIMITS.resultBytes), value: accepted },
        ...(stored.execution.result === undefined ? {} : { reportedResult: stored.execution.result }) }))
    })
  }

  async bindings(principal: ManagementPrincipal, raw: unknown): Promise<RunExecutionBindingsPage> {
    const input = RunExecutionBindingsListInputSchema.parse(raw)
    return this.read(principal, input, async (sql, snapshot) => {
      const stored = await this.execution(sql, snapshot, input.executionId), scope = scopeOf(snapshot)
      const value = RunAcceptedInputValueSchema.parse(stored.input)
      evidence(sameRepeatValue(value.occurrence?.identity ?? null, stored.ref.occurrence)
        && sameRepeatValue(value.runInput, snapshot.run.input))
      // This walks ONE already bounded, exact input snapshot, never prior occurrences.
      const sources = [
        ...value.predecessors.map((source) => ({ kind: 'predecessor' as const, source })),
        ...(value.entry?.external ?? []).map((source) => ({ kind: 'external' as const, source })),
        ...(value.entry?.carry ? [{ kind: 'carry' as const, source: value.entry.carry }] : []),
      ]
      const expected = sources.map(({ kind, source }, ordinal) => RunExecutionBindingSchema.parse({ kind, source, ordinal,
        bindingId: repeatId('repeat-binding', input.executionId, kind, ordinal), recipient: repeatExecutionIdentity(stored.execution),
        recipientOccurrence: stored.ref.occurrence, inputDigest: stored.inputDigest }))
      const cursorScope = [scope, input.executionId, stored.inputDigest]
      const after = decodeBindingPageCursor(cursorScope, input.cursor)
      interface BindingRow { binding_id: string; run_id: string; recipient_execution_id: string; source_execution_id: string;
        source_result_digest: string; input_digest: string; slot_id: string; ordinal: number; record: unknown }
      const rows = (await sql.query<BindingRow>(`select binding_id,run_id,recipient_execution_id,source_execution_id,
        source_result_digest,input_digest,slot_id,ordinal,record from run_repeat_bindings
        where run_id=$1 and recipient_execution_id=$2 and ordinal>$3 order by ordinal limit $4`,
      [input.runId, input.executionId, after, input.limit + 1])).rows
      const window = expected.slice(after + 1, after + input.limit + 2)
      evidence(rows.length === window.length)
      for (const [index, row] of rows.entries()) {
        const binding = window[index]!
        evidence(row.ordinal === binding.ordinal && row.binding_id === binding.bindingId && row.run_id === scope.runId
          && row.recipient_execution_id === input.executionId && row.source_execution_id === binding.source.execution.executionId
          && row.source_result_digest === binding.source.acceptedResultDigest && row.input_digest === stored.inputDigest
          && row.slot_id === stored.slotId && sameRepeatValue(RunExecutionBindingSchema.parse(row.record), binding))
      }
      const items = window.slice(0, input.limit)
      const checked = new Map<string, { identity: unknown; result: unknown }>()
      for (const binding of items) {
        const sourceId = binding.source.execution.executionId
        let source = checked.get(sourceId)
        if (!source) {
          const identities = await sql.query<{ identity: unknown }>(
            'select identity from run_repeat_executions where execution_id=$1 and run_id=$2', [sourceId, scope.runId])
          evidence(identities.rows.length === 1)
          const result = await readRepeatAcceptedResultLocked(sql, snapshot, sourceId)
          evidence(result !== undefined)
          source = { identity: identities.rows[0]!.identity, result }; checked.set(sourceId, source)
        }
        const identity = binding.kind === 'carry' ? binding.source.execution : binding.source.occurrence
          ? { ...binding.source.execution, occurrence: binding.source.occurrence } : binding.source.execution
        evidence(sameRepeatValue(source.identity, identity) && sameRepeatValue(source.result, binding.source.acceptedResult)
          && repeatDigest(source.result, RUN_INSPECTION_LIMITS.resultBytes) === binding.source.acceptedResultDigest)
        if (binding.kind === 'carry') {
          const decision = await readRepeatDecision(sql, scope, binding.source.execution.occurrence.occurrenceId)
          evidence(decision && decision.reason === 'repeat' && decision.decisionId === binding.source.decisionId
            && sameRepeatValue(decision.exitExecution, binding.source.execution)
            && decision.acceptedResultDigest === binding.source.acceptedResultDigest
            && decision.occurrence.identity.blockId === stored.ref.occurrence?.blockId
            && decision.occurrence.identity.occurrenceIndex + 1 === stored.ref.occurrence?.occurrenceIndex)
        }
      }
      return bounded(RunExecutionBindingsPageSchema.parse({ scope, executionId: input.executionId, inputDigest: stored.inputDigest,
        items, pageInfo: { nextCursor: rows.length > input.limit
          ? encodeBindingPageCursor(cursorScope, items.at(-1)!.ordinal) : null } }))
    })
  }

  async version(principal: ManagementPrincipal, raw: unknown): Promise<RunVersionDetail> {
    const input = RunVersionGetInputSchema.parse(raw)
    return this.read(principal, input, async (_sql, snapshot, live) => {
      // Same authorization and immutable version reader as current version reads.
      // A Run-only grant must not implicitly reveal workflow prompts/topology.
      requireAuthorization(live, 'workflows:read', { workspaceId: snapshot.run.workspaceId, workflowId: snapshot.run.workflowId })
      return bounded(RunVersionDetailSchema.parse({ scope: scopeOf(snapshot), version: snapshot.version }))
    })
  }
}
