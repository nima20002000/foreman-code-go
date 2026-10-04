import type { AcceptedWorkflowRunV3 } from '@foreman-code/contracts/wave25'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import type { RepeatStartPreparation } from '../runs/repeatStartAdmission.js'

/** Internal composition only. Never accepted from an HTTP/MCP request. Both
 * callbacks run on manual Start's branded transaction; throwing rolls it back. */
export interface ScheduleStartGuard {
  readonly occurrenceId: string
  readonly signal?: AbortSignal
  readonly preparation: RepeatStartPreparation
  beforeAcceptance(sql: GraphTransactionSql): Promise<void>
  afterAcceptance(sql: GraphTransactionSql, run: AcceptedWorkflowRunV3): Promise<void>
}
