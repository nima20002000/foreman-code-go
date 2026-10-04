import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { NativeSessionReference } from '@foreman-code/contracts'
import type { NativeResponseIdentity } from '../port.js'
import type { NativeResponseDeliveryEvidence } from '../../interactions/delivery.js'
import { privateDirectory, readRecord, recordObject, syncDirectory, writeRecord } from './storage.js'

const fields = ['source', 'harness', 'providerVersion', 'nativeSessionId', 'nativeRequestId',
  'nativeRequestType', 'optionId', 'semantic'] as const
const semantics = ['approve_once', 'allow_turn', 'allow_session', 'reject', 'cancel',
  'provider_scoped_allow', 'persistent_policy_change']

function checked(value: unknown): NativeResponseDeliveryEvidence {
  const proof = recordObject(value)
  if (Object.keys(proof).length !== fields.length || fields.some((key) => typeof proof[key] !== 'string'
    || !String(proof[key]).trim() || String(proof[key]).length > 4096)
    || !['provider_acknowledgement', 'provider_history'].includes(String(proof.source))
    || !['codex', 'opencode'].includes(String(proof.harness))
    || !semantics.includes(String(proof.semantic))) throw new Error('Invalid native response receipt.')
  return Object.fromEntries(fields.map((key) => [key, proof[key]])) as unknown as NativeResponseDeliveryEvidence
}
function key(proof: Pick<NativeResponseDeliveryEvidence, 'harness' | 'providerVersion' | 'nativeSessionId' | 'nativeRequestId'>): string {
  return createHash('sha256').update(JSON.stringify([
    proof.harness, proof.providerVersion, proof.nativeSessionId, proof.nativeRequestId,
  ])).digest('hex')
}
function same(left: NativeResponseDeliveryEvidence, right: NativeResponseDeliveryEvidence): boolean {
  // A second qualified source may independently confirm the same response.
  return fields.filter((field) => field !== 'source').every((field) => left[field] === right[field])
}

/**
 * Immutable, fsynced receipts survive manager/API replacement and caller DB rollback.
 * This store accepts ONLY evidence produced by an adapter, never MCP/HTTP payloads.
 * A missing/corrupt/conflicting file is not permission to retransmit a response.
 */
export class NativeResponseJournal {
  constructor(private readonly root: string) {}

  record(evidence: NativeResponseDeliveryEvidence): void {
    const proof = checked(evidence)
    const directory = privateDirectory(this.root)
    const path = join(directory, `${key(proof)}.json`)
    const envelope = { format: 1, evidence: proof }
    try { writeRecord(path, envelope, true) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const existing = recordObject(readRecord(path))
      if (existing.format !== 1 || !same(checked(existing.evidence), proof)) {
        throw new Error('Conflicting native response receipts; delivery must remain uncertain.', { cause: error })
      }
      // Also repair an interrupted directory fsync from an earlier attempt.
      syncDirectory(directory)
    }
  }

  read(session: NativeSessionReference, response: NativeResponseIdentity): NativeResponseDeliveryEvidence | undefined {
    const directory = privateDirectory(this.root)
    const stored = readRecord(join(directory, `${key({ ...session, nativeRequestId: response.nativeRequestId })}.json`))
    if (stored === undefined) return undefined
    const envelope = recordObject(stored)
    if (envelope.format !== 1) throw new Error('Unsupported native receipt format.')
    const proof = checked(envelope.evidence)
    const expected = { ...session, nativeRequestId: response.nativeRequestId,
      nativeRequestType: response.nativeRequestType, optionId: response.option.optionId,
      semantic: response.option.semantic, source: proof.source }
    if (!same(proof, expected)) throw new Error('The persisted native receipt does not match this exact response.')
    return proof
  }
}
