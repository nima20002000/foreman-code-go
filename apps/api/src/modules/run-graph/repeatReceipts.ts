import { timeRuntimeOperation } from '../../infrastructure/runtimeTiming.js'
import {
  GraphDigestSchema, GraphEvidenceSchema, GraphIdSchema, GraphSequenceSchema,
  RepeatMetadataScopeV1Schema, type GraphEvidence,
} from '@foreman-code/contracts/wave25'

import { DomainError } from '../errors.js'
import { assertGraphTransaction, beforeGraphCommit, poisonGraphTransaction, type GraphSqlClient, type GraphTransactionSql } from './connection.js'
import type { RepeatScope } from '../runs/repeatResolution.js'

/** A private assertion about the EXISTING canonical source/effect tables. This
 * is neither a new journal nor a public v3 fact schema. Receipt rows survive a
 * reset barrier and batch retention; an absent retained batch is not lost proof. */
export interface RepeatCanonicalReceipt {
  scope: RepeatScope
  evidence: GraphEvidence
  sourceDigest: string
  effect: { kind: string; entityId: string; digest: string } | null
  /** The producer can additionally bind its validated occurrence-qualified facts.
   * Source and effect semantic digests must always agree, even without this. */
  semanticDigest?: string
}
export interface RepeatCanonicalReceiptRow {
  workspace_id: string
  workflow_id: string
  workflow_version_id: string
  execution_semantics_version: number
  protocol_version: number
  head_sequence: string
  source_digest: string
  source_semantic_digest: string
  source_sequence: string
  effect_digest: string | null
  effect_semantic_digest: string | null
  effect_sequence: string | null
}
function conflict(): never {
  throw new DomainError('REPEAT_PUBLICATION_RECEIPT_CONFLICT', 'The exact canonical repeat publication receipt is unavailable or inconsistent.', 409)
}

function validatedReceipt(input: RepeatCanonicalReceipt): RepeatCanonicalReceipt {
  const scope = RepeatMetadataScopeV1Schema.parse(input.scope)
  const evidence = GraphEvidenceSchema.parse(input.evidence)
  GraphDigestSchema.parse(input.sourceDigest)
  if (input.semanticDigest !== undefined) GraphDigestSchema.parse(input.semanticDigest)
  if (input.effect) {
    GraphIdSchema.parse(input.effect.kind)
    GraphIdSchema.parse(input.effect.entityId)
    GraphDigestSchema.parse(input.effect.digest)
  }
  return { ...input, scope, evidence, effect: input.effect ? { ...input.effect } : null }
}

/** Read persisted receipts on the SAME branded SQL transaction as the domain
 * mutation. Caller holds the existing Run/head locks; no pool read, nested
 * transaction, head initialization, or in-memory staging counts as readback. */
export async function assertRepeatCanonicalReceiptLocked(sql: GraphTransactionSql,
  input: RepeatCanonicalReceipt): Promise<void> {
  assertGraphTransaction(sql)
  try {
    await timeRuntimeOperation('db', 'graph.check_receipt', () => assertRepeatCanonicalReceipt(sql, input),
      { runId: input.scope.runId })
  } catch (error) {
    // Catching a missing proof must not accidentally commit the domain mutation.
    poisonGraphTransaction(sql)
    throw error
  }
}

/** Read-only validation of an already persisted receipt. This grants no
 * publication, settlement, owner or native-entry capability. Mutation callers
 * must retain the branded/poisoning wrapper above and their commit finalizers. */
export async function assertRepeatCanonicalReceipt(sql: GraphSqlClient,
  input: RepeatCanonicalReceipt): Promise<void> {
  try {
    const receipt = validatedReceipt(input)
    const { scope, evidence } = receipt
    const rows = await sql.query<RepeatCanonicalReceiptRow>(`select r.workspace_id,r.workflow_id,r.workflow_version_id,
        v.execution_semantics_version,h.protocol_version,h.head_sequence::text,
        s.source_digest,s.semantic_digest as source_semantic_digest,s.first_sequence::text as source_sequence,
        e.effect_digest,e.semantic_digest as effect_semantic_digest,e.first_sequence::text as effect_sequence
      from runs r join workflow_versions v on v.id=r.workflow_version_id
      join run_graph_heads h on h.run_id=r.id
      join run_graph_sources s on s.run_id=r.id and s.source_kind=$2 and s.source_id=$3 and s.source_revision=$4::bigint
      left join run_graph_effects e on e.run_id=r.id and e.effect_kind=$5 and e.entity_id=$6
      where r.id=$1`, [scope.runId, evidence.sourceKind, evidence.sourceId, evidence.sourceRevision,
      receipt.effect?.kind ?? null, receipt.effect?.entityId ?? null])
    assertRepeatCanonicalReceiptRows(rows.rows, receipt)
  } catch (error) {
    if (error instanceof DomainError) throw error
    return conflict()
  }
}

/** Validation of rows read by the caller's locked query; it grants no capability. */
export function assertRepeatCanonicalReceiptRows(rows: readonly RepeatCanonicalReceiptRow[],
  input: RepeatCanonicalReceipt): void {
  try {
    const { scope } = validatedReceipt(input)
    const row = rows[0]
    if (rows.length !== 1 || !row || row.workspace_id !== scope.workspaceId
      || row.workflow_id !== scope.workflowId || row.workflow_version_id !== scope.workflowVersionId
      || row.execution_semantics_version !== 3 || row.protocol_version !== 1
      || row.source_digest !== input.sourceDigest
      || !GraphDigestSchema.safeParse(row.source_semantic_digest).success
      || input.semanticDigest !== undefined && row.source_semantic_digest !== input.semanticDigest
      || !GraphSequenceSchema.safeParse(row.head_sequence).success
      || !GraphSequenceSchema.safeParse(row.source_sequence).success) return conflict()
    if (BigInt(row.source_sequence) < 1n || BigInt(row.source_sequence) > BigInt(row.head_sequence)) return conflict()
    if (input.effect && (row.effect_digest !== input.effect.digest
      || row.effect_semantic_digest !== row.source_semantic_digest
      || row.effect_sequence !== row.source_sequence)) return conflict()
  } catch (error) {
    if (error instanceof DomainError) throw error
    return conflict()
  }
}

/** Register AFTER openRunGraphPublication registered its finalizer, and AFTER
 * staging this change. The query runs after G1 has written source/effect rows,
 * before COMMIT. A failed proof rolls the domain and the publication back.
 * This function's return is NOT a native launch permit or a committed receipt. */
export function requireRepeatCanonicalReceiptBeforeCommit(sql: GraphTransactionSql,
  input: RepeatCanonicalReceipt): void {
  assertGraphTransaction(sql)
  // Snapshot the assertion: a caller cannot retarget a registered proof later.
  const receipt: RepeatCanonicalReceipt = {
    scope: { ...input.scope }, evidence: { ...input.evidence }, sourceDigest: input.sourceDigest,
    effect: input.effect ? { ...input.effect } : null,
    ...(input.semanticDigest === undefined ? {} : { semanticDigest: input.semanticDigest }),
  }
  beforeGraphCommit(sql, () => assertRepeatCanonicalReceiptLocked(sql, receipt))
}
