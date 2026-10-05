import { open, readFile, rename, mkdir, unlink, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { remoteActiveNative, RemoteReviewerAssignmentSchema, RemoteReviewerTurnSchema,
  type RemoteReviewerAssignment } from '@foreman-code/contracts/remote-execution'
import { canonicalGraphJson } from '@foreman-code/contracts/wave25'
import { RemoteNativeHistorySchema } from '@foreman-code/contracts/remote-workflow-physical'
import { remoteWorkflowNativeHistory } from './workflowPhysicalReadout.js'
import type { NativeHistory } from '../../harnesses/port.js'
import { DispatchIntentSchema, type DispatchIntent } from '@foreman-code/contracts/node-placement'
import { JobLogChunkSchema, JobExecutionSchema, type JobLogChunk, type JobExecution } from '@foreman-code/contracts/jobs'
import type { DeviceConnectionIdentity } from '@foreman-code/contracts/device-identity'
import { RemoteOperationReceiptSchema, RemoteOwnerControlSchema, RemoteTerminalEvidenceSchema, RemoteNativeIdentitySchema, RemoteInteractionTargetSchema, RemoteOwnerReconciliationSchema,
  type RemoteOperationReceipt, type RemoteOperationStatus, type RemoteOwnerControl,
  type RemoteInteractionTarget, type RemoteNativeIdentity, type RemoteTerminalEvidence, type RemoteOwnerReconciliation } from '@foreman-code/contracts/remote-execution'

import { RemoteJobOperationReceiptSchema, RemoteJobDispatchIntentSchema, RemoteJobOwnerControlSchema, RemoteJobNativeIdentitySchema, RemoteJobTerminalEvidenceSchema,
  type RemoteJobConnectionIdentity, type RemoteJobOperationReceipt, type RemoteJobDispatchIntent, type RemoteJobOwnerControl, type RemoteJobNativeIdentity, type RemoteJobTerminalEvidence, type RemoteJobOperationStatus } from '@foreman-code/contracts/remote-job-execution'

import { JobRuntimeNativeAdmissionSchema, JobQualificationCandidateSchema, JobRuntimeQualificationResultSchema, type JobRuntimeNativeAdmission, type JobQualificationCandidate } from '@foreman-code/contracts/job-runtime'
import { JobNativeOwnerSchema, JobOCICertificateSchema, type JobNativeOwner } from '../../jobs/executorJournal.js'
import { jobSupervisorIdentity } from '../../jobs/executor.js'
import { QualificationReceiptSchema, QualificationOCICertificateSchema, type QualificationReceipt } from '../../jobs/qualificationJournal.js'
import { acquireJournalOwner } from './journalOwner.js'

const ControlDeliverySchema = z.object({
  operationId: z.string(), commandId: z.string(), phase: z.enum(['reserved', 'entered', 'acknowledged']),
}).strict()
const ArchivedWorkflowSchema = z.object({
  operationId: z.string(), executionId: z.string(), attemptId: z.string(), receiptDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
const JournalSchema = z.object({
  schemaVersion: z.literal(1),
  archivedWorkflows: z.array(ArchivedWorkflowSchema).default([]),
  controlDeliveries: z.array(ControlDeliverySchema).default([]),
  jobOwners: z.array(JobNativeOwnerSchema).max(1000).default([]),
  qualificationReceipts: z.array(QualificationReceiptSchema).max(1000).default([]),
  receipts: z.array(z.union([RemoteOperationReceiptSchema, RemoteJobOperationReceiptSchema])),
  reconciliations: z.array(RemoteOwnerReconciliationSchema).max(128),
  jobOutputs: z.array(z.object({
    operationId: z.string(), commandId: z.uuid(), path: z.string(), mediaType: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/), byteSize: z.number().int().nonnegative(),
  }).strict()).default([]),
  jobLogs: z.array(z.object({
    operationId: z.string(), acknowledgedSequence: z.number().int().nonnegative(),
    chunks: z.array(JobLogChunkSchema).max(4096),
  }).strict()).default([]),
}).strict()
const same = isDeepStrictEqual
const journalByteLimit = 4 * 1024 * 1024
const controlReserveBytes = 4096
const retainedReviewTurns = 16
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

/** Single worker owner; the caller must hold the worker installation's exclusive service lock.
 * Every mutating method fsyncs before returning authority to the native adapter.
 * Settled workflow payloads move to cold storage; unresolved ownership and deduplication records remain.
 */
export class RemoteOperationJournal {
  private closed = false
  private faulted = false
  private tail: Promise<unknown> = Promise.resolve()
  private constructor(
    private readonly path: string,
    private data: z.infer<typeof JournalSchema>,
    private readonly capacity: number,
    private readonly byteLimit: number,
    private readonly lock: Awaited<ReturnType<typeof acquireJournalOwner>>,
  ) {}
  static async open(path: string,
    options: { initializeNewInstallation?: boolean; capacity?: number; byteLimit?: number } = {}) {
    const capacity = options.capacity ?? 1000
    const byteLimit = options.byteLimit ?? journalByteLimit
    if (!Number.isSafeInteger(byteLimit) || byteLimit < 16 * 1024 || byteLimit > journalByteLimit) {
      throw new Error('Invalid journal byte limit')
    }
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('Invalid journal capacity')
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const lock = await acquireJournalOwner(path)
    try {
      let data: z.infer<typeof JournalSchema>
      try {
        if ((await stat(path)).size > byteLimit) throw new Error('Journal byte limit reached')
        const serialized = await readFile(path, 'utf8')
        if (Buffer.byteLength(serialized) > byteLimit) throw new Error('Journal byte limit reached')
        data = JournalSchema.parse(JSON.parse(serialized))
      } catch (error) {
        if (lock.recovered || !options.initializeNewInstallation || (error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new Error('Journal unavailable: recovery required', { cause: error })
        }
        data = { schemaVersion: 1, archivedWorkflows: [], controlDeliveries: [], receipts: [],
          qualificationReceipts: [], reconciliations: [], jobOutputs: [], jobLogs: [], jobOwners: [] }
      }
      if (data.receipts.length + data.qualificationReceipts.length > capacity) throw new Error('Journal exceeds capacity')
      const journal = new RemoteOperationJournal(path, data, capacity, byteLimit, lock)
      await journal.persist(journal.serialize(data, { skipControlReserve: true }))
      await journal.compactReviewResults()
      return journal
    } catch (error) { await lock.close(); throw error }
  }
  async close() {
    if (this.closed) return
    this.closed = true
    await this.tail
    this.faulted = true
    await this.lock.close()
  }
  private serialize(data: z.infer<typeof JournalSchema>,
    options: { controlOperationId?: string; skipControlReserve?: boolean } = {}) {
    const serialized = JSON.stringify(JournalSchema.parse(data))
    const active = data.receipts.filter(receipt => !receipt.terminal
      && receipt.intent.operationId !== options.controlOperationId).length
      + data.qualificationReceipts.filter(receipt => receipt.phase !== 'closed').length
    const reserved = options.skipControlReserve ? 0 : active * controlReserveBytes
    if (Buffer.byteLength(serialized) > this.byteLimit - reserved) throw new Error('Journal byte limit reached')
    return serialized
  }
  private async writeSnapshot(path: string, serialized: string) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${randomUUID()}.tmp`
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(serialized)
      await file.sync()
    } catch (error) {
      await unlink(temporary)
      throw error
    } finally {
      await file.close()
    }
    await rename(temporary, path)
    const directory = await open(dirname(path), 'r')
    try { await directory.sync() } finally { await directory.close() }
  }
  private persist(serialized: string) { return this.writeSnapshot(this.path, serialized) }
  private archivePath(operationId: string) { return `${this.path}.settled/${hash(operationId)}.json` }
  private reviewPath(operationId: string, correlationId: string) {
    return `${this.path}.reviews/${hash(operationId)}/${hash(correlationId)}.json`
  }
  private reviewJobPath(operationId: string, jobId: string) {
    return `${this.path}.reviews/${hash(operationId)}/jobs/${hash(jobId)}.json`
  }
  private async archiveReviewResult(operationId: string, turn: z.infer<typeof RemoteReviewerTurnSchema>, history?: NativeHistory) {
    if (!turn.result) throw new Error('Settled review result required')
    const resultDigest = hash(canonicalGraphJson(turn.result, journalByteLimit))
    if (history) turn.historyDigest = hash(canonicalGraphJson(history, journalByteLimit))
    await this.writeSnapshot(this.reviewPath(operationId, turn.assignment.correlationId),
      JSON.stringify({ operationId, turn: { ...turn, resultDigest }, ...(history ? { history } : {}) }))
    await this.writeSnapshot(this.reviewJobPath(operationId, turn.assignment.jobId),
      JSON.stringify({ operationId, correlationId: turn.assignment.correlationId, jobId: turn.assignment.jobId }))
    turn.resultDigest = resultDigest
    delete turn.result
  }
  private compactReviewResults() {
    return this.change(async data => {
      for (const receipt of data.receipts) {
        if ('kind' in receipt) continue
        let compacted = false
        for (const turn of receipt.reviewTurns ?? []) {
          if (turn.settled && turn.result) {
            await this.archiveReviewResult(receipt.intent.operationId, turn)
            compacted = true
          }
        }
        if ((receipt.reviewTurns?.length ?? 0) > retainedReviewTurns) {
          receipt.reviewTurns = receipt.reviewTurns!.slice(-retainedReviewTurns)
          compacted = true
        }
        if (compacted) receipt.sequence++
      }
    })
  }
  private async readArchivedReview(receipt: RemoteOperationReceipt, correlationId: string) {
    const path = this.reviewPath(receipt.intent.operationId, correlationId)
    try {
      if ((await stat(path)).size > journalByteLimit) throw new Error('Review archive byte limit reached')
      const archived = z.object({ operationId: z.string(), turn: RemoteReviewerTurnSchema,
        history: RemoteNativeHistorySchema.optional() }).strict()
        .parse(JSON.parse(await readFile(path, 'utf8')))
      const turn = archived.turn
      if (archived.operationId !== receipt.intent.operationId || !turn.settled || !turn.result
        || turn.assignment.correlationId !== correlationId
        || turn.assignment.session.nativeSessionId !== receipt.native?.sessionId
        || turn.assignment.reviewerAgentId !== receipt.retainedReviewer?.agentId
        || hash(canonicalGraphJson(turn.result, journalByteLimit)) !== turn.resultDigest)
        throw new Error('Review archive changed: recovery required')
      if (turn.historyDigest && (!archived.history
        || hash(canonicalGraphJson(archived.history, journalByteLimit)) !== turn.historyDigest
        || archived.history.terminalTurn?.correlationId !== correlationId
        || archived.history.terminalTurn.providerId !== turn.providerId
        || !same(archived.history.terminalTurn.result, turn.result)))
        throw new Error('Review history archive changed: recovery required')
      return archived
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }
  private async archivedReviewJob(receipt: RemoteOperationReceipt, jobId: string) {
    try {
      const value = z.object({ operationId: z.string(), correlationId: z.string(), jobId: z.string() }).strict()
        .parse(JSON.parse(await readFile(this.reviewJobPath(receipt.intent.operationId, jobId), 'utf8')))
      if (value.operationId !== receipt.intent.operationId || value.jobId !== jobId)
        throw new Error('Review job archive changed: recovery required')
      const turn = await this.readArchivedReview(receipt, value.correlationId)
      if (!turn || turn.turn.assignment.jobId !== jobId) throw new Error('Review job archive unavailable')
      return turn.turn
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }
  private selectArchivedReview(receipt: RemoteOperationReceipt, archived: z.infer<typeof RemoteReviewerTurnSchema>) {
    const { result: _result, ...turn } = archived
    receipt.reviewTurns = [turn, ...(receipt.reviewTurns ?? []).slice(-(retainedReviewTurns - 1))]
    receipt.sequence++
    return turn
  }
  loadReviewTurn(operationId: string, correlationId: string) {
    return this.change(async data => {
      const receipt = this.receipt(data, operationId)
      const existing = receipt.reviewTurns?.find(turn => turn.assignment.correlationId === correlationId)
      if (existing) return existing
      const archived = await this.readArchivedReview(receipt, correlationId)
      return archived ? this.selectArchivedReview(receipt, archived.turn) : undefined
    })
  }
  async reviewResult(operationId: string, correlationId: string) {
    const status = await this.status(operationId)
    if (status.status !== 'known') throw new Error('Unknown review operation')
    const archived = await this.readArchivedReview(status.receipt, correlationId)
    if (!archived?.turn.result) throw new Error('Settled review result unavailable')
    const turn = status.receipt.reviewTurns?.find(value => value.assignment.correlationId === correlationId)
    if (turn && !same({ ...archived.turn, result: undefined }, { ...turn, result: undefined }))
      throw new Error('Review archive changed: recovery required')
    return structuredClone(archived.turn.result)
  }
  async reviewHistory(operationId: string, correlationId: string): Promise<NativeHistory | undefined> {
    const status = await this.status(operationId)
    if (status.status !== 'known') throw new Error('Unknown review operation')
    const archived = await this.readArchivedReview(status.receipt, correlationId)
    return archived?.history ? remoteWorkflowNativeHistory(archived.history) : undefined
  }
  private async archivedReceipt(data: z.infer<typeof JournalSchema>, operationId: string) {
    const archived = data.archivedWorkflows.find(value => value.operationId === operationId)
    if (!archived) return undefined
    const path = this.archivePath(operationId)
    if ((await stat(path)).size > this.byteLimit) throw new Error('Archived receipt byte limit reached')
    const serialized = await readFile(path, 'utf8')
    if (hash(serialized) !== archived.receiptDigest) throw new Error('Archived receipt changed: recovery required')
    const receipt = RemoteOperationReceiptSchema.parse(JSON.parse(serialized))
    if (!receipt.terminal || receipt.intent.operationId !== operationId || receipt.intent.executionId !== archived.executionId
      || receipt.intent.attemptId !== archived.attemptId) throw new Error('Archived ownership changed: recovery required')
    return receipt
  }
  async isRetired(operationId: string) {
    await this.tail
    if (this.faulted) throw new Error('Journal durability uncertain: recovery required')
    return this.data.archivedWorkflows.some(value => value.operationId === operationId)
  }
  retireSettled(intent: DispatchIntent, sequence: number) {
    return this.change(async data => {
      const archived = await this.archivedReceipt(data, intent.operationId)
      if (archived) {
        if (!same(archived.intent, intent) || archived.sequence !== sequence) throw new Error('Retirement ownership conflict')
        return archived
      }
      const receipt = this.receipt(data, intent.operationId)
      if (!same(receipt.intent, intent) || receipt.sequence !== sequence || !receipt.terminal) {
        throw new Error('Confirmed terminal retirement required')
      }
      const serialized = JSON.stringify(receipt)
      await this.writeSnapshot(this.archivePath(intent.operationId), serialized)
      data.archivedWorkflows.push({ operationId: intent.operationId, executionId: intent.executionId,
        attemptId: intent.attemptId, receiptDigest: hash(serialized) })
      data.receipts = data.receipts.filter(value => value.intent.operationId !== intent.operationId)
      data.controlDeliveries = data.controlDeliveries.filter(value => value.operationId !== intent.operationId)
      data.reconciliations = data.reconciliations.filter(value => value.operationId !== intent.operationId)
      return receipt
    })
  }
  private change<T>(apply: (data: z.infer<typeof JournalSchema>) => T | Promise<T>,
    options: { controlOperationId?: string; skipControlReserve?: boolean } = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Journal closed: recovery required'))
    const task = this.tail.then(async () => {
      if (this.faulted) throw new Error('Journal durability uncertain: recovery required')
      const next = structuredClone(this.data)
      const result = await apply(next)
      if (same(next, this.data)) return structuredClone(result)
      const serialized = this.serialize(next, options)
      try { await this.persist(serialized) } catch (error) { this.faulted = true; throw error }
      this.data = next
      return structuredClone(result)
    })
    this.tail = task.catch(() => {})
    return task
  }
  private receipt(data: z.infer<typeof JournalSchema>, operationId: string) {
    const receipt = data.receipts.find((value): value is RemoteOperationReceipt => !('kind' in value) && value.intent.operationId === operationId)
    if (!receipt) throw new Error('Unknown operation: recovery required')
    return receipt
  }
  async status(operationId: string): Promise<RemoteOperationStatus> {
    await this.tail
    if (this.faulted) throw new Error('Journal durability uncertain: recovery required')
    const receipt = this.data.receipts.find((value): value is RemoteOperationReceipt => !('kind' in value) && value.intent.operationId === operationId)
    const retained = receipt ?? await this.archivedReceipt(this.data, operationId)
    return retained ? { status: 'known', receipt: structuredClone(retained) } : { status: 'unknown', reason: 'journal_absence_requires_reconciliation' }
  }
  accept(intent: DispatchIntent, connection: DeviceConnectionIdentity, workerIncarnationId: string) {
    return this.change(async data => {
      intent = DispatchIntentSchema.parse(intent)
      const archived = await this.archivedReceipt(data, intent.operationId)
      if (archived) {
        if (!same(archived.intent, intent)) throw new Error('Operation binding conflict')
        return archived
      }
      const existing = data.receipts.find(value => value.intent.operationId === intent.operationId)
      if (existing) {
        if ('kind' in existing) throw new Error('Operation subject conflict')
        if (!same(existing.intent, intent)) throw new Error('Operation binding conflict')
        return existing
      }
      if (data.archivedWorkflows.some(value => value.executionId === intent.executionId || value.attemptId === intent.attemptId)
        || data.receipts.some(value => value.intent.executionId === intent.executionId || value.intent.attemptId === intent.attemptId)) throw new Error('Execution attempt already bound to another operation')
      if (data.qualificationReceipts.some(value => value.admission.operationId === intent.operationId)) throw new Error('Operation already bound to a qualification')
      if (data.receipts.length + data.qualificationReceipts.length >= this.capacity) throw new Error('Journal full: explicit retention disposition required')
      if (connection.mainId !== intent.mainId) throw new Error('Wrong main identity')
      const receipt = RemoteOperationReceiptSchema.parse({ schemaVersion: 1, intent, connection, workerIncarnationId,
        sequence: 1, phase: 'received', entryAttempted: false, turnEntryAttempted: false, stopFence: false, controls: [] })
      data.receipts.push(receipt)
      return receipt
    })
  }
  reserveEntry(operationId: string) {
    return this.change(async data => {
      const archived = await this.archivedReceipt(data, operationId)
      if (archived) return { reserved: false, receipt: archived }
      const receipt = this.receipt(data, operationId)
      if (receipt.stopFence || receipt.phase !== 'received') return { reserved: false, receipt }
      receipt.entryAttempted = true; receipt.phase = 'native_entry_attempted'; receipt.sequence++
      return { reserved: true, receipt }
    })
  }
  acknowledgeStart(operationId: string, native: RemoteNativeIdentity) {
    return this.change(data => {
      const receipt = this.receipt(data, operationId)
      native = RemoteNativeIdentitySchema.parse(native)
      if (receipt.native) { if (!same(receipt.native, native)) throw new Error('Native ownership conflict'); return receipt }
      if (!['native_entry_attempted', 'stop_requested', 'uncertain'].includes(receipt.phase)) throw new Error('Entry reservation required')
      receipt.native = native
      receipt.phase = receipt.stopFence ? 'stop_requested' : 'start_acknowledged'; receipt.sequence++
      return receipt
    })
  }
  reserveTurn(operationId: string, input: { correlationId: string; promptDigest: string }) {
    return this.change(async data => {
      const archived = await this.archivedReceipt(data, operationId)
      if (archived) {
        if (archived.turnInput && !same(archived.turnInput, input)) throw new Error('Turn input binding conflict')
        return { reserved: false, receipt: archived }
      }
      const receipt = this.receipt(data, operationId)
      if (receipt.turnInput && !same(receipt.turnInput, input)) throw new Error('Turn input binding conflict')
      if (receipt.stopFence || receipt.turnEntryAttempted || receipt.phase !== 'start_acknowledged') return { reserved: false, receipt }
      receipt.turnEntryAttempted = true; receipt.turnInput = input; receipt.sequence++; return { reserved: true, receipt }
    })
  }
  acknowledgeTurn(operationId: string, turnId: string) {
    return this.change(data => {
      const receipt = this.receipt(data, operationId)
      if (!receipt.native || !receipt.turnEntryAttempted || !turnId) throw new Error('Turn entry reservation required')
      if (receipt.native.turnId && receipt.native.turnId !== turnId) throw new Error('Native turn ownership conflict')
      receipt.native.turnId = turnId; receipt.sequence++; return receipt
    })
  }
  retainReviewer(operationId: string, policy: { agentId: string; expiresAt: string }, history: NativeHistory) {
    return this.change(data => {
      const receipt = this.receipt(data, operationId)
      const terminal = history.terminalTurn
      if (receipt.stopFence || receipt.terminal || !receipt.native?.turnId || !terminal
        || terminal.correlationId !== receipt.turnInput?.correlationId || terminal.providerId !== receipt.native.turnId
        || terminal.result.outcome !== 'succeeded' || history.pendingInteractions.length || history.pendingInteraction
        || Date.parse(policy.expiresAt) <= Date.now()) throw new Error('Reviewer workflow settlement mismatch')
      const retained = { ...policy, workflowTurnId: terminal.providerId, result: terminal.result }
      if (receipt.retainedReviewer && !same({ ...receipt.retainedReviewer, expiresAt: policy.expiresAt }, retained))
        throw new Error('Retained reviewer identity changed')
      receipt.retainedReviewer = retained
      receipt.sequence++
      return receipt
    })
  }
  renewReviewer(operationId: string, policy: { agentId: string; expiresAt: string }) {
    return this.change(data => {
      const receipt = this.receipt(data, operationId)
      if (!receipt.retainedReviewer || receipt.retainedReviewer.agentId !== policy.agentId
        || receipt.stopFence || receipt.terminal || Date.parse(policy.expiresAt) <= Date.now())
        throw new Error('Retained reviewer renewal mismatch')
      receipt.retainedReviewer.expiresAt = policy.expiresAt
      receipt.sequence++
      return receipt
    })
  }
  reserveReviewTurn(operationId: string, assignment: RemoteReviewerAssignment, promptDigest: string, afterSequence: number) {
    return this.change(async data => {
      const receipt = this.receipt(data, operationId)
      assignment = RemoteReviewerAssignmentSchema.parse(assignment)
      if (!receipt.retainedReviewer || receipt.retainedReviewer.agentId !== assignment.reviewerAgentId
        || receipt.native?.sessionId !== assignment.session.nativeSessionId || receipt.stopFence || receipt.terminal
        || Date.parse(receipt.retainedReviewer.expiresAt) <= Date.now()) throw new Error('Reviewer lifetime unavailable')
      const turns = receipt.reviewTurns ??= []
      const known = turns.find(turn => turn.assignment.correlationId === assignment.correlationId
        || turn.assignment.jobId === assignment.jobId)
      const prior = known ?? (await this.readArchivedReview(receipt, assignment.correlationId))?.turn
        ?? await this.archivedReviewJob(receipt, assignment.jobId)
      if (prior) {
        if (!same(prior.assignment, assignment) || prior.promptDigest !== promptDigest) throw new Error('Review turn input conflict')
        if (!known) this.selectArchivedReview(receipt, prior)
        return { reserved: !prior.entered, receipt }
      }
      if (turns.some(turn => !turn.settled)) throw new Error('Reviewer turn capacity unavailable')
      receipt.reviewTurns = [...turns.slice(-(retainedReviewTurns - 1)),
        { assignment, promptDigest, afterSequence, entered: false, settled: false }]
      receipt.sequence++
      return { reserved: true, receipt }
    })
  }
  enterReviewTurn(operationId: string, correlationId: string) {
    return this.change(data => {
      const receipt = this.receipt(data, operationId)
      const turn = receipt.reviewTurns?.find(turn => turn.assignment.correlationId === correlationId)
      if (!turn || receipt.stopFence || receipt.terminal) throw new Error('Reviewer entry unavailable')
      if (turn.entered) return false
      turn.entered = true
      receipt.sequence++
      return true
    })
  }
  acknowledgeReviewTurn(operationId: string, correlationId: string, providerId: string) {
    return this.change(data => {
      const receipt = this.receipt(data, operationId)
      const turn = receipt.reviewTurns?.find(turn => turn.assignment.correlationId === correlationId)
      if (!turn || !providerId || turn.providerId && turn.providerId !== providerId)
        throw new Error('Review turn acknowledgement mismatch')
      if (turn.providerId === providerId) return receipt
      turn.providerId = providerId
      receipt.sequence++
      return receipt
    })
  }
  settleReviewTurn(operationId: string, history: NativeHistory) {
    return this.change(async data => {
      const receipt = this.receipt(data, operationId)
      const terminal = history.terminalTurn
      const turn = receipt.reviewTurns?.find(turn => turn.assignment.correlationId === terminal?.correlationId)
      if (!turn || !terminal || turn.providerId !== terminal.providerId
        || history.pendingInteraction || history.pendingInteractions.length) throw new Error('Review turn settlement mismatch')
      const resultDigest = hash(canonicalGraphJson(terminal.result, journalByteLimit))
      if (turn.settled && (turn.resultDigest ? turn.resultDigest !== resultDigest : !same(turn.result, terminal.result)))
        throw new Error('Review result conflict')
      if (!turn.settled || !turn.historyDigest) {
        turn.settled = true
        turn.result = terminal.result
        await this.archiveReviewResult(operationId, turn, history)
        receipt.sequence++
      }
      return receipt
    })
  }
  confirmRecovered(operationId: string, native: RemoteNativeIdentity) {
    return this.change(data => {
      const receipt = this.receipt(data, operationId)
      if (!receipt.native || !same(receipt.native, native)) throw new Error('Original recovered native identity required')
      if (receipt.phase !== 'confirmed_terminal') {
        receipt.phase = receipt.stopFence ? 'stop_requested' : receipt.native.turnId && receipt.turnEntryAttempted ? 'running' : 'start_acknowledged'
        delete receipt.uncertainty; receipt.sequence++
      }
      return receipt
    })
  }
  markRunning(operationId: string) {
    return this.change(data => {
      const receipt = this.receipt(data, operationId)
      if (receipt.phase === 'running' || receipt.stopFence) return receipt
      if (receipt.phase !== 'start_acknowledged') throw new Error('Start acknowledgment required')
      receipt.phase = 'running'; receipt.sequence++; return receipt
    })
  }
  interaction(operationId: string, target: RemoteInteractionTarget) {
    return this.change(data => {
      const receipt = this.receipt(data, operationId)
      target = RemoteInteractionTargetSchema.parse(target)
      if (!same(receipt.native, target.native) || receipt.phase !== 'running' || receipt.stopFence) throw new Error('Interaction native ownership mismatch')
      receipt.interaction = target; receipt.sequence++; return receipt
    })
  }
  control(command: RemoteOwnerControl) {
    return this.change(async data => {
      command = RemoteOwnerControlSchema.parse(command)
      const archived = await this.archivedReceipt(data, command.operationId)
      const receipt = archived ?? this.receipt(data, command.operationId)
      const prior = receipt.controls.find(value => value.commandId === command.commandId)
      if (prior) { if (!same(prior, command)) throw new Error('Control command conflict'); return { dispatch: false, receipt } }
      if (receipt.intent.attemptId !== command.attemptId || receipt.intent.executionId !== command.executionId
        || receipt.intent.bindingHash !== command.bindingHash || !same(receipt.intent.owner, command.owner)) throw new Error('Stale control ownership')
      if (command.nativeTarget && (command.nativeTarget.kind !== 'session' || command.nativeTarget.sessionId !== receipt.native?.sessionId
        || (command.nativeTarget.turnId && command.nativeTarget.turnId !== remoteActiveNative(receipt)?.turnId))) throw new Error('Wrong explicit native target')
      if (command.native && !same(command.native, remoteActiveNative(receipt))) throw new Error('Wrong native control target')
      if (command.action.kind === 'respond') {
        const target = receipt.interaction
        if (receipt.stopFence || receipt.phase !== 'running' || !target || target.interactionId !== command.action.interactionId
          || target.interactionRevision !== command.action.interactionRevision || target.nativeInteractionId !== command.action.nativeInteractionId) throw new Error('Response is not currently eligible')
        if (receipt.controls.some(value => value.action.kind === 'respond' && value.action.nativeInteractionId === target.nativeInteractionId
          && value.native?.sessionId === target.native.sessionId && value.native?.turnId === target.native.turnId)) throw new Error('Interaction response already reserved')
      }
      if (archived) return { dispatch: false, receipt }
      if (receipt.controls.length >= 128) throw new Error('Control journal full')
      receipt.controls.push(command)
      data.controlDeliveries.push({ operationId: command.operationId, commandId: command.commandId, phase: 'reserved' })
      if (command.action.kind === 'stop') { receipt.stopFence = true; if (receipt.phase !== 'confirmed_terminal') receipt.phase = 'stop_requested' }
      receipt.sequence++
      return { dispatch: receipt.phase !== 'confirmed_terminal' && receipt.native !== undefined, receipt }
    }, { controlOperationId: command.operationId })
  }
  async controlDelivery(command: RemoteOwnerControl) {
    await this.tail
    if (this.faulted) throw new Error('Journal durability uncertain: recovery required')
    const receipt = await this.archivedReceipt(this.data, command.operationId) ?? this.receipt(this.data, command.operationId)
    const prior = receipt.controls.find(value => value.commandId === command.commandId)
    if (!prior) return undefined
    if (!same(prior, command)) throw new Error('Control command conflict')
    // Older records reserved and entered in one step; their native effects may have happened.
    return this.data.controlDeliveries.find(value => value.operationId === command.operationId
      && value.commandId === command.commandId)?.phase ?? 'entered'
  }
  enterControlDelivery(command: RemoteOwnerControl) {
    return this.change(data => {
      const receipt = this.receipt(data, command.operationId)
      const prior = receipt.controls.find(value => value.commandId === command.commandId)
      if (!prior || !same(prior, command)) throw new Error('Original control reservation required')
      const active = remoteActiveNative(receipt)
      let deliveryOwner = command.owner
      if (command.action.kind === 'respond') {
        for (const transition of data.reconciliations) {
          if (transition.operationId === command.operationId && same(transition.previousOwner, deliveryOwner))
            deliveryOwner = transition.nextOwner
        }
      }
      if (!same(receipt.intent.owner, deliveryOwner)
        || command.native && !same(command.native, active)) throw new Error('Stale control ownership')
      if (command.nativeTarget && (command.nativeTarget.kind !== 'session'
        || command.nativeTarget.sessionId !== receipt.native?.sessionId
        || command.nativeTarget.turnId && command.nativeTarget.turnId !== active?.turnId)) {
        throw new Error('Wrong explicit native target')
      }
      const delivery = data.controlDeliveries.find(value => value.operationId === command.operationId
        && value.commandId === command.commandId)
      if (!delivery || delivery.phase !== 'reserved' || receipt.terminal || !receipt.native
        || command.action.kind === 'respond' && receipt.stopFence) return false
      delivery.phase = 'entered'
      return true
    }, { controlOperationId: command.operationId })
  }
  acknowledgeControl(command: RemoteOwnerControl) {
    return this.change(data => {
      const delivery = data.controlDeliveries.find(value => value.operationId === command.operationId
        && value.commandId === command.commandId)
      if (!delivery || delivery.phase === 'reserved') throw new Error('Control delivery entry required')
      delivery.phase = 'acknowledged'
    }, { controlOperationId: command.operationId })
  }
  revokeFence(operationId: string) {
    return this.change(data => {
      const receipt = this.receipt(data, operationId)
      if (receipt.phase !== 'confirmed_terminal') {
        receipt.stopFence = true; receipt.phase = 'stop_requested'; receipt.uncertainty = 'Authority revoked; physical closure pending'; receipt.sequence++
      }
      return receipt
    }, { controlOperationId: operationId })
  }
  uncertain(operationId: string, reason: string) {
    return this.change(data => {
      const receipt = this.receipt(data, operationId)
      if (receipt.phase !== 'confirmed_terminal') { receipt.phase = 'uncertain'; receipt.uncertainty = reason.slice(0, 500); receipt.sequence++ }
      return receipt
    }, { controlOperationId: operationId })
  }
  terminal(operationId: string, evidence: RemoteTerminalEvidence) {
    return this.change(async data => {
      const receipt = await this.archivedReceipt(data, operationId) ?? this.receipt(data, operationId)
      evidence = RemoteTerminalEvidenceSchema.parse(evidence)
      if (receipt.terminal) { if (!same(receipt.terminal, evidence)) throw new Error('Conflicting terminal evidence'); return receipt }
      if (evidence.kind !== 'not_started' && !receipt.native) throw new Error('Native ownership evidence required')
      if (evidence.kind === 'not_started' && (receipt.entryAttempted || receipt.native || !receipt.stopFence || !['received', 'stop_requested'].includes(receipt.phase))) throw new Error('Non-entry not proven')
      receipt.terminal = evidence; receipt.phase = 'confirmed_terminal'; receipt.sequence++; return receipt
    })
  }
  reconcileOwner(transition: RemoteOwnerReconciliation) {
    return this.change(data => {
      transition = RemoteOwnerReconciliationSchema.parse(transition)
      const prior = data.reconciliations.find(value => value.commandId === transition.commandId)
      if (prior) { if (!same(prior, transition)) throw new Error('Reconciliation command conflict'); return this.receipt(data, transition.operationId) }
      const receipt = this.receipt(data, transition.operationId)
      if (!same(receipt.intent.owner, transition.previousOwner) || !same(receipt.native, transition.native)
        || !/^[a-f0-9]{64}$/.test(transition.evidenceDigest) || BigInt(transition.nextOwner.epoch) <= BigInt(transition.previousOwner.epoch)) throw new Error('Original execution reconciliation evidence required')
      if (data.reconciliations.length >= 128) throw new Error('Reconciliation journal full')
      data.reconciliations.push(structuredClone(transition)); receipt.intent.owner = transition.nextOwner; receipt.sequence++; return receipt
    })
  }
  private qualificationReceipt(data: z.infer<typeof JournalSchema>, operationId: string) {
    const receipt = data.qualificationReceipts.find(value => value.admission.operationId === operationId)
    if (!receipt) throw new Error('Unknown qualification: original-owner reconciliation required')
    return receipt
  }
  async qualificationStatus(operationId: string): Promise<QualificationReceipt | null> {
    await this.tail
    if (this.faulted) throw new Error('Journal durability uncertain: recovery required')
    return structuredClone(this.data.qualificationReceipts.find(value => value.admission.operationId === operationId) ?? null)
  }
  qualificationAccept(raw: JobRuntimeNativeAdmission, rawCandidate: JobQualificationCandidate) {
    return this.change(data => {
      const admission = JobRuntimeNativeAdmissionSchema.parse(raw)
      const candidate = JobQualificationCandidateSchema.parse(rawCandidate)
      if (candidate.operationId !== admission.operationId || candidate.approvalId !== admission.approvalId || candidate.qualificationId !== admission.qualificationId) throw new Error('Qualification candidate subject changed')
      const existing = data.qualificationReceipts.find(value => value.admission.operationId === admission.operationId)
      if (existing) { if (!same(existing.admission, admission) || !same(existing.candidate, candidate)) throw new Error('Qualification admission conflict'); return existing }
      if (data.archivedWorkflows.some(value => value.operationId === admission.operationId)
        || data.receipts.some(value => value.intent.operationId === admission.operationId) || data.qualificationReceipts.some(value =>
        value.admission.approvalId === admission.approvalId || value.admission.leaseId === admission.leaseId)) throw new Error('Original qualification identity already bound')
      if (data.qualificationReceipts.length >= 1000 || data.receipts.length + data.qualificationReceipts.length >= this.capacity) throw new Error('Journal full: explicit retention disposition required')
      if (Date.parse(admission.expiresAt) <= Date.now()) throw new Error('Qualification admission expired')
      const receipt = QualificationReceiptSchema.parse({ admission, candidate, result: null, sequence: 1, phase: 'received', launches: [], container: null })
      data.qualificationReceipts.push(receipt); return receipt
    })
  }
  qualificationReserveEntry(operationId: string) {
    return this.change(data => {
      const receipt = this.qualificationReceipt(data, operationId)
      if (receipt.phase !== 'received' || Date.parse(receipt.admission.expiresAt) <= Date.now()) return { reserved: false, receipt }
      receipt.phase = 'native_entry_attempted'; receipt.sequence++; return { reserved: true, receipt }
    })
  }
  qualificationReserveProcess(operationId: string, input: { launchId: string; binary: string; argv: string[] }) {
    return this.change(data => {
      const receipt = this.qualificationReceipt(data, operationId)
      if (receipt.phase !== 'native_entry_attempted' || receipt.launches.some(value => value.launchId === input.launchId) ||
        receipt.launches.some(value => !value.closed) || receipt.launches.length >= 512) throw new Error('Original qualification process reservation unavailable')
      receipt.launches.push({ ...input, exit: null, closed: false }); receipt.sequence++; return receipt
    })
  }
  qualificationProcessExit(operationId: string, launchId: string, exit: { exitCode: number | null; signal: string | null }) {
    return this.change(data => {
      const receipt = this.qualificationReceipt(data, operationId), launch = receipt.launches.find(value => value.launchId === launchId)
      if (!launch || launch.closed) throw new Error('Original qualification launch missing')
      if (launch.exit && !same(launch.exit, exit)) throw new Error('Original qualification exit changed')
      launch.exit = exit; receipt.sequence++; return receipt
    })
  }
  qualificationProcessClosed(operationId: string, launchId: string) {
    return this.change(data => {
      const receipt = this.qualificationReceipt(data, operationId), launch = receipt.launches.find(value => value.launchId === launchId)
      if (!launch) throw new Error('Original qualification launch missing')
      launch.closed = true; receipt.sequence++; return receipt
    })
  }
  qualificationContainerIntent(operationId: string, identity: string, fingerprint: string) {
    return this.change(data => {
      const receipt = this.qualificationReceipt(data, operationId)
      if (identity !== `graphql-ci-qualification-${receipt.admission.qualificationId}` || fingerprint !== receipt.admission.fingerprintDigest ||
        receipt.phase !== 'native_entry_attempted') throw new Error('Original qualification container intent changed')
      if (receipt.container) { if (receipt.container.identity !== identity || receipt.container.fingerprint !== fingerprint) throw new Error('Original qualification container intent changed'); return receipt }
      receipt.container = { identity, fingerprint, containerId: null, certificate: null }; receipt.sequence++; return receipt
    })
  }
  qualificationBindContainer(operationId: string, identity: string, containerId: string) {
    return this.change(data => {
      const receipt = this.qualificationReceipt(data, operationId), container = receipt.container
      if (!container || container.identity !== identity || container.containerId && container.containerId !== containerId) throw new Error('Original qualification container identity changed')
      container.containerId = containerId; receipt.sequence++; return receipt
    })
  }
  qualificationCertificate(operationId: string, raw: unknown) {
    return this.change(data => {
      const receipt = this.qualificationReceipt(data, operationId), certificate = QualificationOCICertificateSchema.parse(raw), container = receipt.container
      const subject = certificate.scope.subject, admission = receipt.admission
      if (!container || container.containerId !== certificate.containerId || !same(certificate.scope.admission, admission) ||
        subject.operationId !== operationId || subject.qualificationId !== admission.qualificationId || subject.profileId !== admission.profileId ||
        subject.profileRevision !== admission.profileRevision || subject.fingerprint !== admission.fingerprintDigest || certificate.scope.bootId !== admission.bootId ||
        certificate.process.bootId !== admission.bootId || certificate.helpers.some(value => value.process.bootId !== admission.bootId)) throw new Error('Original qualification certificate scope changed')
      if (container.certificate && (!same({ ...container.certificate, lifecycle: certificate.lifecycle }, certificate) ||
        container.certificate.lifecycle === 'closed' && certificate.lifecycle !== 'closed')) throw new Error('Original qualification certificate identity changed')
      container.certificate = certificate; receipt.sequence++; return receipt
    })
  }
  qualificationClose(operationId: string) {
    return this.change(data => {
      const receipt = this.qualificationReceipt(data, operationId)
      if (receipt.phase !== 'closed') {
        if (receipt.launches.some(value => !value.closed) || receipt.container && receipt.container.certificate?.lifecycle !== 'closed') throw new Error('Original physical qualification closure unconfirmed')
        receipt.phase = 'closed'; receipt.sequence++
      }
      return receipt
    })
  }
  qualificationResult(operationId: string, raw: unknown) {
    return this.change(data => {
      const receipt = this.qualificationReceipt(data, operationId), result = JobRuntimeQualificationResultSchema.parse(raw)
      if (receipt.result) { if (!same(receipt.result, result)) throw new Error('Original qualification result changed'); return receipt }
      if (result.outcome === 'qualified' && (receipt.phase !== 'closed' || receipt.container?.certificate?.lifecycle !== 'closed' ||
        result.measurement.approvalId !== receipt.admission.approvalId || result.measurement.qualificationId !== receipt.admission.qualificationId ||
        result.measurement.fingerprintDigest !== receipt.admission.fingerprintDigest || !same(result.measurement.fingerprint, receipt.candidate.fingerprint))) throw new Error('Original measured qualification closure/context missing')
      if (result.outcome === 'denied' && result.closure === 'confirmed' && receipt.phase !== 'closed') throw new Error('Original physical qualification closure unconfirmed')
      if (result.outcome === 'denied' && result.closure === 'unconfirmed') receipt.phase = 'uncertain'
      receipt.result = result; receipt.sequence++; return receipt
    })
  }

  private jobReceipt(data: z.infer<typeof JournalSchema>, operationId: string) {
    const receipt = data.receipts.find((value): value is RemoteJobOperationReceipt => 'kind' in value && value.intent.operationId === operationId)
    if (!receipt) throw new Error('Unknown job operation: recovery required')
    return receipt
  }
  async jobStatus(operationId: string): Promise<RemoteJobOperationStatus> {
    await this.tail
    if (this.faulted) throw new Error('Journal durability uncertain: recovery required')
    const receipt = this.data.receipts.find((value): value is RemoteJobOperationReceipt => 'kind' in value && value.intent.operationId === operationId)
    return receipt ? { status: 'known', receipt: structuredClone(receipt) } : { status: 'unknown', reason: 'journal_absence_requires_reconciliation' }
  }
  async jobOperations(): Promise<RemoteJobOperationReceipt[]> {
    await this.tail
    if (this.faulted) throw new Error('Journal durability uncertain: recovery required')
    return structuredClone(this.data.receipts.filter((receipt): receipt is RemoteJobOperationReceipt => 'kind' in receipt))
  }
  async jobCancellationConnection(execution: JobExecution): Promise<RemoteJobConnectionIdentity> {
    await this.tail
    if (this.closed || this.faulted) throw new Error('Original journal unavailable for cancellation')
    const existing = this.data.receipts.find(value => value.intent.operationId === execution.operationId)
    if (existing) {
      if (!('kind' in existing)) throw new Error('Job operation binding conflict')
      return structuredClone(existing.connection)
    }
    const spec = execution.acceptedSpec
    const matches = this.data.qualificationReceipts.filter(receipt => {
      if (receipt.phase !== 'closed' || receipt.result?.outcome !== 'qualified' || !receipt.admission.connection) return false
      const measurement = receipt.result.measurement
      return measurement.runtime.policyId === spec.policy.isolationPolicyId
        && measurement.runtime.policyRevision === spec.policy.isolationPolicyRevision
        && measurement.runtime.imageDigest === spec.policy.imageDigest
        && measurement.runtime.toolchainDigest === spec.policy.toolchainDigest
        && same(measurement.hostRef, spec.target.hostRef) && same(measurement.registration, spec.target.registration)
        && measurement.fingerprint.mainInstallationId === spec.target.mainInstallationId
        && measurement.root.binding.workspaceId === execution.workspaceId
        && measurement.root.selection.rootPolicyId === spec.target.destination.rootPolicyId
        && measurement.root.selection.rootPolicyRevision === spec.target.destination.rootPolicyRevision
    })
    if (matches.length !== 1) throw new Error('Original Job connection missing or ambiguous')
    return structuredClone(matches[0]!.admission.connection!)
  }
  jobCancelBeforeEntry(intent: RemoteJobDispatchIntent, raw: JobExecution, connection: RemoteJobConnectionIdentity,
    workerIncarnationId: string, command: RemoteJobOwnerControl, rawTerminal: RemoteJobTerminalEvidence) {
    return this.change(data => {
      const execution = JobExecutionSchema.parse(raw)
      const terminal = RemoteJobTerminalEvidenceSchema.parse(rawTerminal)
      if (terminal.outcome !== 'cancelled' || terminal.exitCode !== null || terminal.signal !== null
        || !terminal.processStopped) throw new Error('No-entry cancellation terminal required')
      if (intent.executionId !== execution.id || intent.attemptId !== execution.attemptId
        || intent.operationId !== execution.operationId || intent.bindingHash !== execution.acceptedSpec.bindingHash
        || intent.inputDigest !== `sha256:${execution.acceptedSpec.specDigest}` || !same(intent.owner, execution.owner)) {
        throw new Error('Job cancellation execution ownership mismatch')
      }
      if (data.jobOwners.some(owner => owner.operationId === intent.operationId)) {
        throw new Error('Original Job native entry owner requires physical reconciliation')
      }
      const receipt = this.acceptJob(data, intent, execution, connection, workerIncarnationId)
      if (receipt.entryAttempted || receipt.native || (receipt.terminal && receipt.terminal.outcome !== 'cancelled')) {
        throw new Error('Original Job entry requires physical reconciliation')
      }
      if (!same(receipt.connection, connection) || !same(receipt.execution.acceptedSpec, execution.acceptedSpec)) {
        throw new Error('Original Job cancellation binding changed')
      }
      this.recordJobControl(data, command)
      if (receipt.terminal && !same(receipt.terminal, terminal)) throw new Error('Job cancellation terminal conflict')
      if (!receipt.terminal) {
        receipt.terminal = terminal
        receipt.phase = 'confirmed_terminal'
        receipt.sequence++
        receipt.observedAt = new Date().toISOString()
      }
      return receipt
    })
  }
  jobAccept(raw: RemoteJobDispatchIntent, execution: JobExecution, connection: RemoteJobConnectionIdentity, workerIncarnationId: string) {
    return this.change(data => this.acceptJob(data, raw, execution, connection, workerIncarnationId))
  }
  private acceptJob(data: z.infer<typeof JournalSchema>, raw: RemoteJobDispatchIntent, execution: JobExecution,
    connection: RemoteJobConnectionIdentity, workerIncarnationId: string) {
      const intent = RemoteJobDispatchIntentSchema.parse(raw)
      if (data.archivedWorkflows.some(value => value.operationId === intent.operationId)) throw new Error('Operation subject conflict')
      const existing = data.receipts.find(value => value.intent.operationId === intent.operationId)
      if (existing) {
        if (!('kind' in existing) || !same(existing.intent, intent)) throw new Error('Job operation binding conflict')
        return existing
      }
      if (data.archivedWorkflows.some(value => value.executionId === intent.executionId || value.attemptId === intent.attemptId)
        || data.receipts.some(value => value.intent.executionId === intent.executionId || value.intent.attemptId === intent.attemptId)) throw new Error('Execution attempt already bound to another operation')
      if (data.qualificationReceipts.some(value => value.admission.operationId === intent.operationId)) throw new Error('Operation already bound to a qualification')
      if (data.receipts.length + data.qualificationReceipts.length >= this.capacity) throw new Error('Journal full: explicit retention disposition required')
      if (connection.mainId !== intent.mainId) throw new Error('Wrong main identity')
      const receipt = RemoteJobOperationReceiptSchema.parse({ schemaVersion: 1, kind: 'job', intent, execution, connection, workerIncarnationId,
        sequence: 1, observedAt: new Date().toISOString(), phase: 'received', entryAttempted: false, stopFence: false, controls: [], publication: 'pending' })
      data.receipts.push(receipt); return receipt
  }
  jobReserveEntry(operationId: string) {
    return this.change(data => {
      const receipt = this.jobReceipt(data, operationId)
      if (receipt.stopFence || receipt.phase !== 'received') return { reserved: false, receipt }
      receipt.entryAttempted = true; receipt.phase = 'native_entry_attempted'; receipt.sequence++; receipt.observedAt = new Date().toISOString()
      return { reserved: true, receipt }
    })
  }
  jobAcknowledgeLaunch(operationId: string, raw: RemoteJobNativeIdentity) {
    return this.change(data => {
      const receipt = this.jobReceipt(data, operationId), native = RemoteJobNativeIdentitySchema.parse(raw)
      if (receipt.native) { if (!same(receipt.native, native)) throw new Error('Job native ownership conflict'); return receipt }
      if (!receipt.entryAttempted || receipt.phase === 'confirmed_terminal') throw new Error('Job entry reservation required')
      receipt.native = native; receipt.phase = receipt.stopFence ? 'stop_requested' : 'running'; receipt.sequence++; receipt.observedAt = new Date().toISOString(); return receipt
    })
  }
  jobControl(raw: RemoteJobOwnerControl) {
    return this.change(data => this.recordJobControl(data, raw), { controlOperationId: raw.operationId })
  }
  private recordJobControl(data: z.infer<typeof JournalSchema>, raw: RemoteJobOwnerControl) {
      const command = RemoteJobOwnerControlSchema.parse(raw), receipt = this.jobReceipt(data, command.operationId)
      const prior = receipt.controls.find(value => value.commandId === command.commandId)
      if (prior) { if (!same(prior, command)) throw new Error('Job control command conflict'); return { dispatch: false, receipt } }
      if (command.attemptId !== receipt.intent.attemptId || command.executionId !== receipt.intent.executionId || command.bindingHash !== receipt.intent.bindingHash
        || !same(command.owner, receipt.intent.owner) || !same(command.subject, receipt.intent.subject)) throw new Error('Stale job control ownership')
      if (command.native && !same(command.native, receipt.native)) throw new Error('Wrong job native control target')
      if (receipt.controls.length >= 128) throw new Error('Job control journal full')
      receipt.controls.push(command); receipt.stopFence = true
      if (receipt.phase !== 'confirmed_terminal') receipt.phase = 'stop_requested'
      receipt.sequence++; receipt.observedAt = new Date().toISOString(); return { dispatch: receipt.native !== undefined && !receipt.terminal, receipt }
  }
  jobTerminal(operationId: string, raw: RemoteJobTerminalEvidence) {
    return this.change(data => {
      const receipt = this.jobReceipt(data, operationId), evidence = RemoteJobTerminalEvidenceSchema.parse(raw)
      if (receipt.terminal) { if (!same(receipt.terminal, evidence)) throw new Error('Job terminal evidence conflict'); return receipt }
      if (receipt.entryAttempted && !receipt.native) throw new Error('Attempted OCI entry requires original container reconciliation')
      receipt.terminal = evidence; receipt.phase = 'confirmed_terminal'; receipt.sequence++; receipt.observedAt = new Date().toISOString(); return receipt
    })
  }
  jobPublication(operationId: string, phase: RemoteJobOperationReceipt['publication']) {
    return this.change(data => {
      const receipt = this.jobReceipt(data, operationId)
      if (!receipt.terminal) throw new Error('Physical job closure required before publication')
      if (receipt.publication === phase || receipt.publication === 'complete' || receipt.publication === 'failed') return receipt
      const order = ['pending', 'process_recorded', 'collecting', 'complete', 'failed']
      if (order.indexOf(phase) < order.indexOf(receipt.publication)) return receipt
      receipt.publication = phase; receipt.sequence++; receipt.observedAt = new Date().toISOString(); return receipt
    })
  }
  jobUncertain(operationId: string, reason: string) {
    return this.change(data => {
      const receipt = this.jobReceipt(data, operationId)
      if (!receipt.terminal) receipt.phase = 'uncertain'
      receipt.uncertainty = reason.slice(0, 500); receipt.sequence++; receipt.observedAt = new Date().toISOString(); return receipt
    })
  }

  /** Repeated diagnostics can renew one installed runtime; native owners keep their selected diagnostic. */
  async qualifiedJobRuntime(execution: JobExecution): Promise<QualificationReceipt> {
    await this.tail
    if (this.faulted) throw new Error('Journal durability uncertain: recovery required')
    const spec = execution.acceptedSpec
    const retained = this.data.jobOwners.find(value => value.operationId === execution.operationId)?.qualificationOperationId
    const matches = this.data.qualificationReceipts.flatMap(receipt => {
      if (receipt.phase !== 'closed' || receipt.result?.outcome !== 'qualified') return []
      const measurement = receipt.result.measurement
      const runtime = measurement.runtime
      const matching = (!retained || receipt.admission.operationId === retained)
        && runtime.policyId === spec.policy.isolationPolicyId
        && runtime.policyRevision === spec.policy.isolationPolicyRevision
        && runtime.imageDigest === spec.policy.imageDigest
        && runtime.toolchainDigest === spec.policy.toolchainDigest
        && same(measurement.hostRef, spec.target.hostRef)
        && same(measurement.registration, spec.target.registration)
        && measurement.fingerprint.mainInstallationId === spec.target.mainInstallationId
        && measurement.root.binding.workspaceId === execution.workspaceId
        && measurement.root.selection.rootPolicyId === spec.target.destination.rootPolicyId
        && measurement.root.selection.rootPolicyRevision === spec.target.destination.rootPolicyRevision
        && measurement.root.selection.locationRevision === spec.target.destination.locationRevision
        && (Boolean(retained) || Date.parse(measurement.expiresAt) > Date.now())
      return matching ? [{ receipt, checkedAt: Date.parse(measurement.checkedAt) }] : []
    })
    const first = matches[0]
    if (!first) throw new Error('Original qualified Job runtime missing or ambiguous: recovery required')
    const context = { ...first.receipt.candidate, qualificationId: null, operationId: null, approvalId: null }
    if (matches.some(({ receipt }) => !same(context, {
      ...receipt.candidate, qualificationId: null, operationId: null, approvalId: null,
    }))) throw new Error('Original qualified Job runtime missing or ambiguous: recovery required')
    matches.sort((left, right) => right.checkedAt - left.checkedAt
      || right.receipt.admission.operationId.localeCompare(left.receipt.admission.operationId))
    return structuredClone(matches[0]!.receipt)
  }

  private jobOwner(data: z.infer<typeof JournalSchema>, operationId: string): JobNativeOwner {
    const receipt = this.jobReceipt(data, operationId)
    if (!receipt.entryAttempted) throw new Error('Original Job native reservation required')
    let owner = data.jobOwners.find(value => value.operationId === operationId)
    if (!owner) {
      owner = { operationId, qualificationOperationId: null, timedOut: false, connection: receipt.connection, launches: [], container: null }
      data.jobOwners.push(owner)
    }
    if (!same(owner.connection, receipt.connection)) throw new Error('Original Job host changed')
    return owner
  }
  async jobNativeOwner(operationId: string): Promise<JobNativeOwner | null> {
    await this.tail
    if (this.faulted) throw new Error('Journal durability uncertain: recovery required')
    return structuredClone(this.data.jobOwners.find(value => value.operationId === operationId) ?? null)
  }
  jobReserveProcess(operationId: string, input: { launchId: string; processOwner?: string; binary: string; argv: string[] }) {
    return this.change(data => {
      const receipt = this.jobReceipt(data, operationId)
      const rootOwner = `job:${operationId}:${receipt.intent.owner.grantId}:${receipt.intent.owner.epoch}`
      if (input.processOwner && ![rootOwner, `${rootOwner}:control`, `${rootOwner}:wait`].includes(input.processOwner)) {
        throw new Error('Job controller owner differs from its original operation')
      }
      const owner = this.jobOwner(data, operationId)
      if (owner.launches.some(value => value.launchId === input.launchId)) throw new Error('Job native launch already reserved')
      owner.launches.push({ ...input, exit: null, closed: false })
    })
  }
  jobProcessClosed(operationId: string, launchId: string, exit?: { exitCode: number | null; signal: string | null }) {
    return this.change(data => {
      const launch = this.jobOwner(data, operationId).launches.find(value => value.launchId === launchId)
      if (!launch) throw new Error('Original Job native launch missing')
      if (exit) {
        if (launch.exit && !same(launch.exit, exit)) throw new Error('Original Job native exit changed')
        launch.exit = exit
      }
      launch.closed = true
    })
  }
  jobContainerIntent(operationId: string, identity: string, fingerprint: string, qualificationOperationId?: string) {
    return this.change(data => {
      const receipt = this.jobReceipt(data, operationId), owner = this.jobOwner(data, operationId)
      if (qualificationOperationId) {
        if (owner.qualificationOperationId && owner.qualificationOperationId !== qualificationOperationId) throw new Error('Original Job qualifier changed')
        const qualification = this.qualificationReceipt(data, qualificationOperationId)
        if (qualification.result?.outcome !== 'qualified' || qualification.phase !== 'closed') throw new Error('Original Job qualifier unavailable')
        owner.qualificationOperationId = qualificationOperationId
      }
      if (identity !== jobSupervisorIdentity(receipt.execution) || fingerprint !== receipt.execution.acceptedSpec.specDigest) throw new Error('Original Job container intent changed')
      if (owner.container) {
        if (owner.container.identity !== identity || owner.container.fingerprint !== fingerprint) throw new Error('Original Job container intent conflict')
        return
      }
      owner.container = { identity, fingerprint, containerId: null, deadlineAt: null, certificate: null }
    })
  }
  jobBindContainer(operationId: string, identity: string, containerId: string) {
    return this.change(data => {
      const container = this.jobOwner(data, operationId).container
      if (!container || container.identity !== identity || container.containerId && container.containerId !== containerId) throw new Error('Original Job container conflict')
      container.containerId = containerId
      container.deadlineAt ??= new Date(Date.now() + this.jobReceipt(data, operationId).execution.acceptedSpec.policy.executionTimeoutMs).toISOString()
    })
  }
  jobTimedOut(operationId: string) {
    return this.change(data => { this.jobOwner(data, operationId).timedOut = true })
  }
  jobCertificate(operationId: string, raw: unknown) {
    return this.change(data => {
      const receipt = this.jobReceipt(data, operationId), owner = this.jobOwner(data, operationId), container = owner.container
      const certificate = JobOCICertificateSchema.parse(raw), scope = certificate.scope, target = receipt.execution.acceptedSpec.target
      if (!container || container.containerId !== certificate.containerId || scope.subject.executionId !== receipt.intent.executionId ||
        scope.subject.attemptId !== receipt.intent.attemptId || scope.subject.operationId !== operationId || scope.subject.bindingHash !== receipt.intent.bindingHash ||
        scope.leaseId !== operationId || !same(scope.owner, receipt.intent.owner) || scope.bootId !== owner.connection.bootId ||
        scope.observedDeviceId !== (target.hostRef.kind === 'device' ? target.hostRef.deviceId : null) ||
        scope.observedInstallationId !== (target.registration?.workerInstallationId ?? target.mainInstallationId) || certificate.process.bootId !== scope.bootId ||
        certificate.helpers.some(helper => helper.process.bootId !== scope.bootId)) throw new Error('Original Job certificate scope changed')
      if (container.certificate && (!same(container.certificate.scope, scope) || !same(container.certificate.process, certificate.process) ||
        !same(container.certificate.boundary, certificate.boundary))) throw new Error('Original Job process boundary changed')
      if (container.certificate?.lifecycle === 'closed' && certificate.lifecycle !== 'closed') throw new Error('Closed Job boundary cannot reopen')
      container.certificate = certificate
    })
  }

  jobAppendLog(operationId: string, raw: JobLogChunk) {
    return this.change(data => {
      const receipt = this.jobReceipt(data, operationId), chunk = JobLogChunkSchema.parse(raw)
      if (chunk.executionId !== receipt.intent.executionId || chunk.attemptId !== receipt.intent.attemptId || Buffer.byteLength(chunk.text) !== chunk.byteSize) throw new Error('Job log binding mismatch')
      let spool = data.jobLogs.find(value => value.operationId === operationId)
      if (!spool) { spool = { operationId, acknowledgedSequence: 0, chunks: [] }; data.jobLogs.push(spool) }
      const prior = spool.chunks.find(value => value.sequence === chunk.sequence)
      if (prior) { if (!same(prior, chunk)) throw new Error('Job log sequence conflict'); return }
      if (chunk.sequence !== (spool.chunks.at(-1)?.sequence ?? 0) + 1) throw new Error('Job log sequence gap')
      if (spool.chunks.length >= 4096 || chunk.byteSize > receipt.execution.acceptedSpec.policy.maxLogChunkBytes
        || spool.chunks.reduce((sum, value) => sum + value.byteSize, chunk.byteSize) > receipt.execution.acceptedSpec.policy.maxWorkerSpoolBytes) throw new Error('Bounded worker log spool full')
      spool.chunks.push(chunk)
    })
  }
  async jobPendingLogs(operationId: string) {
    await this.tail
    if (this.faulted) throw new Error('Journal durability uncertain: recovery required')
    const spool = this.data.jobLogs.find(value => value.operationId === operationId)
    return structuredClone(spool?.chunks.filter(value => value.sequence > spool.acknowledgedSequence) ?? [])
  }
  jobAcknowledgeLog(operationId: string, sequence: number) {
    return this.change(data => {
      const spool = data.jobLogs.find(value => value.operationId === operationId)
      if (!spool || sequence <= spool.acknowledgedSequence) return
      if (sequence !== spool.acknowledgedSequence + 1 || !spool.chunks.some(value => value.sequence === sequence)) throw new Error('Unpersisted job log acknowledgment')
      spool.acknowledgedSequence = sequence
    })
  }

  jobOutputCommand(operationId: string, input: { path: string; mediaType: string; sha256: string; byteSize: number }) {
    return this.change(data => {
      const receipt = this.jobReceipt(data, operationId)
      if (!receipt.terminal) throw new Error('Job physical closure required before sealing outputs')
      const declared = receipt.execution.acceptedSpec.outputs.find(output => output.path === input.path)
      if (!declared || declared.mediaType !== input.mediaType || !/^[a-f0-9]{64}$/.test(input.sha256) || !Number.isSafeInteger(input.byteSize)
        || input.byteSize < 0 || input.byteSize > receipt.execution.acceptedSpec.policy.maxOutputBytes) throw new Error('Unaccepted job output metadata')
      const existing = data.jobOutputs.find(output => output.operationId === operationId && output.path === input.path)
      if (existing) {
        if (existing.sha256 !== input.sha256 || existing.byteSize !== input.byteSize || existing.mediaType !== input.mediaType) throw new Error('Original sealed job output changed')
        return existing.commandId
      }
      const outputs = data.jobOutputs.filter(output => output.operationId === operationId)
      if (outputs.length >= 64 || outputs.reduce((total, output) => total + output.byteSize, input.byteSize) > receipt.execution.acceptedSpec.policy.maxOutputBytes) throw new Error('Job output sealing budget exceeded')
      const commandId = randomUUID()
      data.jobOutputs.push({ operationId, commandId, ...input }); return commandId
    })
  }

}
