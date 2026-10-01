import { DispatchIntentSchema, type AcceptedNodePlacement, type DispatchIntent } from '@graphql/contracts/node-placement'
import { canonicalGraphJson, sameWorkflowValue } from '@graphql/contracts/wave25'
import { assertGraphTransaction, beforeGraphCommit, type GraphTransactionSql } from '../run-graph/connection.js'
import type { RunOwnership } from '../runs/ownership.js'
import { DomainError } from '../errors.js'
import type { PlacementCommitFence } from './admission.js'
import { readPlacement } from './binding.js'

const conflict = (): never => { throw new DomainError('PLACEMENT_BINDING_CONFLICT', 'Immutable placement or dispatch evidence conflicts.', 409) }
/** Start calls this on the SAME transaction as Run, canonical receipt and command
 * receipt. It returns no native-entry capability and publishes no wakeup. */
export async function insertAcceptedPlacements(sql: GraphTransactionSql, runId: string,
  nodes: readonly { id: string; agentId: string }[], configurationIds: Readonly<Record<string, string>>,
  placements: readonly AcceptedNodePlacement[], fence: PlacementCommitFence): Promise<void> {
  assertGraphTransaction(sql)
  if (placements.length !== nodes.length || new Set(placements.map((p) => p.nodeId)).size !== nodes.length) conflict()
  const pins = placements.map(readPlacement)
  for (const pin of pins) {
    const node = nodes.find((node) => node.id === pin.nodeId)
    if (pin.runId !== runId || !node || pin.payload.kind !== 'agent' || pin.payload.agentId !== node.agentId
      || pin.payload.agentConfigurationVersionId !== configurationIds[node.agentId]) conflict()
    await fence.assertCurrent(pin)
    await sql.query(`insert into run_node_placements(run_id,node_id,binding_hash,record) values($1,$2,$3,$4::jsonb)`,
      [runId, pin.nodeId, pin.bindingHash, canonicalGraphJson(pin)])
  }
  beforeGraphCommit(sql, async () => {
    for (const pin of pins) await fence.assertCurrent(pin)
    const rows = await sql.query<{ record: unknown }>('select record from run_node_placements where run_id=$1 order by node_id', [runId])
    if (!sameWorkflowValue(rows.rows.map((r) => readPlacement(r.record)), [...pins].sort((a, b) => a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0))) conflict()
  })
}
export async function readAcceptedPlacement(sql: Pick<GraphTransactionSql, 'query'>, runId: string, nodeId: string): Promise<AcceptedNodePlacement | undefined> {
  const rows = await sql.query<{ record: unknown }>('select record from run_node_placements where run_id=$1 and node_id=$2', [runId, nodeId])
  const row = rows.rows[0]
  if (!row) return undefined
  const pin = readPlacement(row.record)
  if (pin.runId !== runId || pin.nodeId !== nodeId || rows.rows.length !== 1) conflict()
  return pin
}
/** Called with execution admission on the existing Run owner transaction. Intent
 * membership is NOT the one-use native launch permission; existing launch guards
 * and live destination revalidation are still required before submission. */
export async function insertDispatchIntent(sql: GraphTransactionSql, owner: RunOwnership,
  raw: DispatchIntent, fence: PlacementCommitFence): Promise<DispatchIntent> {
  assertGraphTransaction(sql)
  owner.assertOwned()
  const intent = DispatchIntentSchema.parse(raw)
  if (owner.runId !== intent.runId) conflict()
  const placement = await readAcceptedPlacement(sql, intent.runId, intent.nodeId)
  if (!placement || placement.bindingHash !== intent.bindingHash || placement.mainId !== intent.mainId) conflict()
  await fence.assertCurrent(placement!)
  const existing = await sql.query<{ record: unknown }>('select record from execution_dispatch_intents where operation_id=$1', [intent.operationId])
  if (existing.rows.length) {
    if (existing.rows.length !== 1 || !sameWorkflowValue(DispatchIntentSchema.parse(existing.rows[0]?.record), intent)) conflict()
    return intent
  }
  const scheduler = await owner.readOneShotFence(sql)
  await sql.query(`insert into execution_dispatch_intents(operation_id,execution_id,run_id,node_id,binding_hash,
    attempt_id,record,scheduler_owner_id,scheduler_owner_fence) values($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
    on conflict(operation_id) do nothing`, [intent.operationId, intent.executionId, intent.runId, intent.nodeId,
    intent.bindingHash, intent.attemptId, canonicalGraphJson(intent), scheduler.ownerId, scheduler.fence])
  const verify = async () => {
    owner.assertOwned()
    await owner.readOneShotFence(sql)
    await fence.assertCurrent(placement!)
    const rows = await sql.query<{ record: unknown }>('select record from execution_dispatch_intents where operation_id=$1', [intent.operationId])
    if (rows.rows.length !== 1 || !sameWorkflowValue(DispatchIntentSchema.parse(rows.rows[0]?.record), intent)) conflict()
  }
  await verify()
  beforeGraphCommit(sql, verify)
  return intent
}

/** Immutable evidence read only. Callers still authorize the live owner/grant
 * before publishing artifacts or control; a receipt is not a delegation. */
export async function readDispatchIntent(sql: Pick<GraphTransactionSql, 'query'>, executionId: string): Promise<DispatchIntent | undefined> {
  const rows = await sql.query<{ operation_id: string; execution_id: string; run_id: string; node_id: string;
    binding_hash: string; attempt_id: string; record: unknown }>(`select operation_id,execution_id,run_id,node_id,
      binding_hash,attempt_id,record from execution_dispatch_intents where execution_id=$1`, [executionId])
  const row = rows.rows[0]
  if (!row) return undefined
  const intent = DispatchIntentSchema.parse(row.record)
  if (rows.rows.length !== 1 || intent.operationId !== row.operation_id || intent.executionId !== executionId
    || intent.executionId !== row.execution_id || intent.runId !== row.run_id || intent.nodeId !== row.node_id
    || intent.bindingHash !== row.binding_hash || intent.attemptId !== row.attempt_id) conflict()
  const placement = await readAcceptedPlacement(sql, intent.runId, intent.nodeId)
  if (!placement || placement.bindingHash !== intent.bindingHash || placement.mainId !== intent.mainId) conflict()
  return intent
}
