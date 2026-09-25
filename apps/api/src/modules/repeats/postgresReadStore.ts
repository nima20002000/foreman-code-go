import {
  GraphIdSchema, RepeatDecisionMetadataV1Schema, RepeatDecisionV1Schema,
  RepeatOccurrenceReadItemSchema, RepeatRunReadInputSchema,
} from '@graphql/contracts/wave25'
import type pg from 'pg'
import { DomainError } from '../errors.js'
import type { RepeatOccurrenceReadStore } from './readback.js'

const StoreInputSchema = RepeatRunReadInputSchema.omit({ cursor: true }).extend({
  workflowVersionId: GraphIdSchema, afterOccurrenceId: GraphIdSchema.optional(),
}).strict()
interface Row {
  cursor_valid: boolean
  occurrence_id: string | null
  block_id: string | null
  occurrence_index: number | null
  occurrence: unknown
  decision: unknown | null
  decision_id: string | null
  exit_execution_id: string | null
  result_digest: string | null
  accepted_result_digest: string | null
}
function invalid(): never {
  throw new DomainError('REPEAT_READBACK_RECORD_INVALID', 'Persisted repeat readback does not match its exact physical identity and result binding.', 409)
}
function compare(a: Row, b: Row): number {
  return Buffer.compare(Buffer.from(a.block_id!), Buffer.from(b.block_id!))
    || a.occurrence_index! - b.occurrence_index!
    || Buffer.compare(Buffer.from(a.occurrence_id!), Buffer.from(b.occurrence_id!))
}

/** Authorization belongs to RepeatReadbackService. One SQL snapshot resolves
 * the scoped cursor, page and accepted-result bindings. No native authority,
 * launch, mutable Agent read, input body, or manufactured occurrence is used.
 * Ordering is block/index/ID, not append order: refresh active Runs from page 1. */
export class PostgresRepeatOccurrenceReadStore implements RepeatOccurrenceReadStore {
  constructor(private readonly pool: Pick<pg.Pool, 'query'>) {}

  async list(raw: Parameters<RepeatOccurrenceReadStore['list']>[0]) {
    const input = StoreInputSchema.parse(raw)
    // Only this trusted boolean chooses a SQL projection; values stay parameters.
    const decision = input.includeResultData ? 'd.record' : "d.record - 'resultData'"
    const result = await this.pool.query<Row>(`
      with cursor_row as (
        select block_id,occurrence_index,occurrence_id from run_repeat_occurrences
        where workspace_id=$1 and workflow_id=$2 and run_id=$3 and workflow_version_id=$4 and occurrence_id=$5
      ), page as (
        select o.occurrence_id,o.block_id,o.occurrence_index,o.record as occurrence,
          ${decision} as decision,d.decision_id,d.exit_execution_id,d.result_digest,
          r.result_digest as accepted_result_digest
        from run_repeat_occurrences o
        left join run_repeat_decisions d on d.occurrence_id=o.occurrence_id and d.run_id=o.run_id
        left join run_repeat_results r on r.execution_id=d.exit_execution_id and r.occurrence_id=o.occurrence_id
          and r.run_id=o.run_id and r.result_digest=d.result_digest
        where o.workspace_id=$1 and o.workflow_id=$2 and o.run_id=$3 and o.workflow_version_id=$4
          and ($5::text is null or (o.block_id collate "C",o.occurrence_index,o.occurrence_id collate "C") >
            (select block_id collate "C",occurrence_index,occurrence_id collate "C" from cursor_row))
        order by o.block_id collate "C",o.occurrence_index,o.occurrence_id collate "C" limit $6
      )
      select ($5::text is null or exists(select 1 from cursor_row)) as cursor_valid,page.*
      from (select 1) sentinel left join page on true
      order by page.block_id collate "C",page.occurrence_index,page.occurrence_id collate "C"`,
    [input.workspaceId, input.workflowId, input.runId, input.workflowVersionId, input.afterOccurrenceId ?? null, input.limit + 1])
    if (!result.rows.length || result.rows.length > input.limit + 1) return invalid()
    if (result.rows.some((row) => row.cursor_valid !== true)) {
      throw new DomainError('REPEAT_CURSOR_INVALID', 'The occurrence cursor is unavailable in this exact Run/version scope. Refresh from the first page.', 409)
    }
    if (result.rows[0]!.occurrence_id === null) {
      if (result.rows.length !== 1 || result.rows[0]!.occurrence !== null || result.rows[0]!.decision !== null) return invalid()
      return { items: [], nextCursor: null }
    }
    const items = result.rows.map((row, index) => {
      if (!row.occurrence_id || !row.block_id || !Number.isInteger(row.occurrence_index)
        || row.occurrence_index! < 1 || row.occurrence_id === input.afterOccurrenceId
        || (index > 0 && compare(result.rows[index - 1]!, row) >= 0)) return invalid()
      const parsedDecision = row.decision === null ? null
        : (input.includeResultData ? RepeatDecisionV1Schema : RepeatDecisionMetadataV1Schema).safeParse(row.decision)
      if (parsedDecision && !parsedDecision.success) return invalid()
      const item = RepeatOccurrenceReadItemSchema.safeParse({
        occurrence: row.occurrence, decision: parsedDecision?.data ?? null,
      })
      if (!item.success) return invalid()
      const identity = item.data.occurrence.identity, scope = identity.scope
      if (identity.occurrenceId !== row.occurrence_id || identity.blockId !== row.block_id
        || identity.occurrenceIndex !== row.occurrence_index || scope.workspaceId !== input.workspaceId
        || scope.workflowId !== input.workflowId || scope.runId !== input.runId
        || scope.workflowVersionId !== input.workflowVersionId || scope.executionSemanticsVersion !== 3) return invalid()
      const savedDecision = item.data.decision
      if (savedDecision === null) {
        if (row.decision_id !== null || row.exit_execution_id !== null || row.result_digest !== null
          || row.accepted_result_digest !== null) return invalid()
      } else if (savedDecision.decisionId !== row.decision_id || savedDecision.exitExecution.executionId !== row.exit_execution_id
        || savedDecision.acceptedResultDigest !== row.result_digest || row.accepted_result_digest !== row.result_digest) return invalid()
      return item.data
    })
    const hasMore = items.length > input.limit
    if (hasMore) items.pop()
    return { items, nextCursor: hasMore ? items.at(-1)!.occurrence.identity.occurrenceId : null }
  }
}
