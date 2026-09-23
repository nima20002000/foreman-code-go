import type { HarnessNativeEvent } from '@graphql/contracts'
import type { NativeGraphObservation, NativeGraphProjectionKey } from '@graphql/contracts/wave25'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import { nativeGraphSource } from '../run-graph/nativeIngestion.js'
import { nativeProjectionId } from '../run-graph/nativeProjection.js'
import { normalizeNativeProducerEvent } from '../run-graph/nativeProducerNormalization.js'
import { matchesOpenCodeHistorySource, readOpenCodeReconciliation,
  type OpenCodeReconciliationIdentity } from './opencodeReconciliation.js'

/** Resolve provenance inside the existing publication/owner transaction. The
 * marker has its OWN source; its referenced raw history must already be durable
 * and valid. This cannot create a correlation, change generation or authorize a
 * native effect. Both bridges still require their original writer correlation. */
export async function openCodeGraphReconciliation(sql: GraphTransactionSql, event: HarnessNativeEvent,
  expected: OpenCodeReconciliationIdentity, scope: NativeGraphObservation['scope'],
  work: NativeGraphProjectionKey, generation: string): Promise<NativeGraphObservation | undefined> {
  if (event.executionId !== work.execution.executionId || expected.ownerAgentId !== work.execution.agentId) return undefined
  const proof = readOpenCodeReconciliation(event, expected)
  if (!proof) return undefined
  const row = (await sql.query<{ record: HarnessNativeEvent; source_sequence: string }>(`select record,source_sequence::text
    from harness_native_events where execution_id=$1 and connection_id=$2 and source_sequence=$3`,
  [event.executionId, proof.historySource.connectionId, proof.historySource.sequence])).rows[0]
  if (!row || row.record.executionId !== event.executionId) return undefined
  const raw = normalizeNativeProducerEvent({ ...row.record, sequence: Number(row.source_sequence) })
  if (raw.rejected || !matchesOpenCodeHistorySource(proof, raw.event)) return undefined
  const source = nativeGraphSource(event)
  return { scope, work, source, sourceStreamId: nativeProjectionId('stream', event.executionId, event.connectionId ?? null),
    sourcePosition: String(event.sequence), connectionGeneration: generation, observedAt: event.occurredAt,
    submissionId: proof.nativeTurnId, kind: 'terminal', terminal: { outcome: proof.outcome,
      evidenceKind: 'provider_terminal', evidenceId: source.sourceId, nativeSettled: true } }
}
