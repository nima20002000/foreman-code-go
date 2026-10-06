import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { ExecutionResultSchema, NativeSessionReferenceSchema,
  type ExecutionResult, type NativeSessionReference } from '@foreman-code/contracts'
import { z } from 'zod'
import type { NativeOutputCallCapture, NativeResponseIdentity } from '../port.js'
import type { NativeResponseDeliveryEvidence } from '../../interactions/delivery.js'
import { privateDirectory, readRecord, recordObject, syncDirectory, writeRecord } from './storage.js'
import { responseValueDigest } from '../../interactions/delivery.js'
import { isDeepStrictEqual } from 'node:util'
import { bootIdentity, identityAlive } from './linuxIdentity.js'

export interface NativeOutputAutoApprovalRecord {
  session: NativeSessionReference
  rootTurnId: string
  process: { bootId: string; pid: number; startTicks: string; generation: number }
  approval: NonNullable<NativeOutputCallCapture['nativeAutoApproval']>
}

function checkedAuto(value: unknown): NativeOutputAutoApprovalRecord {
  const row = recordObject(value)
  const session = recordObject(row.session)
  const nativeProcess = recordObject(row.process)
  const approval = recordObject(row.approval)
  const strings = [session.providerVersion, session.nativeSessionId, row.rootTurnId,
    approval.nativeRequestId, approval.nativeSessionId, approval.permission,
    approval.assistantMessageId, approval.callId]
  if (session.harness !== 'opencode' || strings.some(value => typeof value !== 'string' || !value.trim() || value.length > 4096)
    || approval.nativeSessionId !== session.nativeSessionId || approval.reply !== 'once'
    || !isDeepStrictEqual(approval.patterns, ['*'])
    || typeof nativeProcess.bootId !== 'string' || !/^[0-9a-f-]{36}$/.test(nativeProcess.bootId)
    || !Number.isSafeInteger(nativeProcess.pid) || Number(nativeProcess.pid) <= 1
    || typeof nativeProcess.startTicks !== 'string' || !/^[0-9]+$/.test(nativeProcess.startTicks)
    || !Number.isSafeInteger(nativeProcess.generation) || Number(nativeProcess.generation) < 0) {
    throw new Error('Invalid native output automatic approval receipt.')
  }
  return row as unknown as NativeOutputAutoApprovalRecord
}
function autoKey(session: NativeSessionReference, rootTurnId: string, assistantMessageId: string, callId: string) {
  return createHash('sha256').update(JSON.stringify([
    session.harness, session.providerVersion, session.nativeSessionId, rootTurnId, assistantMessageId, callId,
  ])).digest('hex')
}

const fields = ['source', 'harness', 'providerVersion', 'nativeSessionId', 'nativeRequestId',
  'nativeRequestType', 'optionId', 'semantic'] as const
const semantics = ['approve_once', 'allow_turn', 'allow_session', 'reject', 'cancel',
  'provider_scoped_allow', 'persistent_policy_change']
const TurnAttemptSchema = z.object({ format: z.literal(1), session: NativeSessionReferenceSchema,
  correlationId: z.string().min(1), attemptId: z.uuid(),
  result: ExecutionResultSchema.refine(result => result.outcome !== 'succeeded').optional() }).strict()

function rejectedTurnKey(session: NativeSessionReference, correlationId: string): string {
  return 'turn-rejection-' + createHash('sha256').update(JSON.stringify([
    session.harness, session.providerVersion, session.nativeSessionId, correlationId,
  ])).digest('hex')
}

function checked(value: unknown): NativeResponseDeliveryEvidence {
  const proof = recordObject(value)
  const keys = proof.responseDigest === undefined ? fields : [...fields, 'responseDigest']
  if (Object.keys(proof).length !== keys.length || fields.some((key) => typeof proof[key] !== 'string'
    || !String(proof[key]).trim() || String(proof[key]).length > 4096)
    || !['provider_acknowledgement', 'provider_history'].includes(String(proof.source))
    || !['codex', 'opencode'].includes(String(proof.harness))
    || !semantics.includes(String(proof.semantic))
    || proof.responseDigest !== undefined && !/^[a-f0-9]{64}$/.test(String(proof.responseDigest))) {
    throw new Error('Invalid native response receipt.')
  }
  return Object.fromEntries(keys.map((key) => [key, proof[key]])) as unknown as NativeResponseDeliveryEvidence
}
function key(proof: Pick<NativeResponseDeliveryEvidence, 'harness' | 'providerVersion' | 'nativeSessionId' | 'nativeRequestId'>): string {
  return createHash('sha256').update(JSON.stringify([
    proof.harness, proof.providerVersion, proof.nativeSessionId, proof.nativeRequestId,
  ])).digest('hex')
}
function same(left: NativeResponseDeliveryEvidence, right: NativeResponseDeliveryEvidence): boolean {
  // A second qualified source may independently confirm the same response.
  return fields.filter((field) => field !== 'source').every((field) => left[field] === right[field])
    && left.responseDigest === right.responseDigest
}

/**
 * Immutable, fsynced receipts survive manager/API replacement and caller DB rollback.
 * This store accepts ONLY evidence produced by an adapter, never MCP/HTTP payloads.
 * A missing/corrupt/conflicting file is not permission to retransmit a response.
 */
export class NativeResponseJournal {
  constructor(private readonly root: string) {}

  beginTurnAttempt(session: NativeSessionReference, correlationId: string): string {
    const record = TurnAttemptSchema.parse({ format: 1, session, correlationId, attemptId: randomUUID() })
    const directory = privateDirectory(this.root)
    const path = join(directory, `${rejectedTurnKey(session, correlationId)}.json`)
    writeRecord(path, record)
    return record.attemptId
  }

  recordTurnRejection(session: NativeSessionReference, correlationId: string, attemptId: string,
    result: ExecutionResult): void {
    const record = TurnAttemptSchema.parse({ format: 1, session, correlationId, attemptId, result })
    const directory = privateDirectory(this.root)
    const path = join(directory, `${rejectedTurnKey(session, correlationId)}-${attemptId}.json`)
    try { writeRecord(path, record, true) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const existing = TurnAttemptSchema.parse(readRecord(path))
      if (JSON.stringify(existing) !== JSON.stringify(record)) throw new Error('Conflicting native turn rejection.', { cause: error })
      syncDirectory(directory)
    }
    const latestPath = join(directory, `${rejectedTurnKey(session, correlationId)}.json`)
    const latest = TurnAttemptSchema.parse(readRecord(latestPath))
    if (latest.attemptId === attemptId) writeRecord(latestPath, record)
  }

  readTurnRejection(session: NativeSessionReference, correlationId: string): ExecutionResult | undefined {
    const directory = privateDirectory(this.root)
    const stored = readRecord(join(directory, `${rejectedTurnKey(session, correlationId)}.json`))
    if (stored === undefined) return undefined
    const record = TurnAttemptSchema.parse(stored)
    if (record.session.harness !== session.harness || record.session.providerVersion !== session.providerVersion
      || record.session.nativeSessionId !== session.nativeSessionId || record.correlationId !== correlationId) {
      throw new Error('The native turn rejection belongs to another request.')
    }
    return record.result
  }

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
      semantic: response.option.semantic, source: proof.source,
      ...(proof.responseDigest === undefined ? {} : { responseDigest: responseValueDigest(response.option.response) }) }
    if (!same(proof, expected)) throw new Error('The persisted native receipt does not match this exact response.')
    return proof
  }

  recordNativeOutputAutoApproval(evidence: NativeOutputAutoApprovalRecord): void {
    const proof = checkedAuto(evidence)
    const directory = privateDirectory(this.root)
    const path = join(directory, `native-output-auto-${autoKey(proof.session, proof.rootTurnId,
      proof.approval.assistantMessageId, proof.approval.callId)}.json`)
    try { writeRecord(path, { format: 1, evidence: proof }, true) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const existing = recordObject(readRecord(path))
      if (existing.format !== 1 || !isDeepStrictEqual(checkedAuto(existing.evidence), proof)) {
        throw new Error('Conflicting native output automatic approval receipts.', { cause: error })
      }
      syncDirectory(directory)
    }
  }

  readNativeOutputAutoApproval(session: NativeSessionReference, rootTurnId: string,
    assistantMessageId: string, callId: string, nativeProcess: NativeOutputAutoApprovalRecord['process']) {
    const directory = privateDirectory(this.root)
    const stored = readRecord(join(directory, `native-output-auto-${autoKey(session, rootTurnId, assistantMessageId, callId)}.json`))
    if (stored === undefined) return undefined
    const envelope = recordObject(stored)
    if (envelope.format !== 1) throw new Error('Unsupported native output automatic approval receipt format.')
    const proof = checkedAuto(envelope.evidence)
    if (!isDeepStrictEqual(proof.session, session) || proof.rootTurnId !== rootTurnId
      || proof.approval.assistantMessageId !== assistantMessageId || proof.approval.callId !== callId
      || !isDeepStrictEqual(proof.process, nativeProcess)
      || nativeProcess.bootId !== bootIdentity() || !identityAlive(nativeProcess)) {
      throw new Error('The persisted automatic approval belongs to another native process or call.')
    }
    return proof.approval
  }
}
