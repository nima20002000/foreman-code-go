import type { ExecutionResult, HarnessExecution } from '@foreman-code/contracts'
import type { OutputReferenceKind, WorkflowVersionV3 } from '@foreman-code/contracts/wave25'
import { deliverableFailure, deliverableVerdict, type DeliverableContract } from '../interactions/deliverable.js'
import { repeatTickIndex } from './repeatResolution.js'

interface Queryable { query(text: string, values: unknown[]): Promise<{ rows: unknown[] }> }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A reference is valid only for a record this same execution created. */
export async function referenceCreatedByExecution(db: Queryable, kind: OutputReferenceKind, value: string,
  workspaceId: string, executionId: string): Promise<boolean> {
  if (kind !== 'ciTicket' || !UUID.test(value)) return false
  const result = await db.query(`select 1 from ci_runs where id=$1 and workspace_id=$2 and record#>>'{initiator,executionId}'=$3`,
    [value, workspaceId, executionId])
  return result.rows.length > 0
}

/** The deliverable contract of one workflow Agent activation; none for interval checks or Job nodes. */
export function workflowDeliverableContract(version: WorkflowVersionV3, execution: HarnessExecution,
  referenceExists: DeliverableContract['referenceExists']): DeliverableContract | undefined {
  const node = version.definition.nodes.find(item => item.id === execution.workflowNodeId)
  if (!node || node.kind === 'job' || repeatTickIndex(execution.input) !== undefined) return undefined
  const repeatExit = version.definition.repeat?.blocks.some(block => block.exitNodeId === node.id) ?? false
  return {
    source: version.definition.handoffs || repeatExit ? 'latestDeliverable' : node.choice || node.artifactOutputs ? 'data' : 'text',
    outputSchema: node.outputSchema, referenceExists,
  }
}

/** The final failed result for a completed activation whose deliverable still fails its contract. The
 * native coordinator has already spent the repair turns; this runs where the first terminal is normalized. */
export async function workflowDeliverableFailure(db: Queryable, version: WorkflowVersionV3,
  execution: HarnessExecution): Promise<ExecutionResult | undefined> {
  if (execution.state !== 'completed' || execution.result?.outcome !== 'succeeded') return undefined
  const contract = workflowDeliverableContract(version, execution,
    (kind, value) => referenceCreatedByExecution(db, kind, value, version.workspaceId, execution.id))
  const verdict = contract && await deliverableVerdict(execution.result, contract)
  return verdict ? deliverableFailure(verdict) : undefined
}
