import { open, readFile, rename, mkdir, unlink, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { constants, openSync, closeSync, fstatSync, lstatSync, readFileSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'
import { bootIdentity, identityAlive, processIdentity } from '../../harnesses/recovery/linuxIdentity.js'
import { z } from 'zod'
import { DispatchIntentSchema, type DispatchIntent } from '@foreman-code/contracts/node-placement'
import { JobLogChunkSchema, type JobLogChunk } from '@foreman-code/contracts/jobs'
import { JobExecutionRecordSchema, type JobExecutionRecord } from '@foreman-code/contracts/job-verification'
import { SourcePreparationClosureSchema, type SourcePreparationClosure } from '@foreman-code/contracts/source-admission'
import type { DeviceConnectionIdentity } from '@foreman-code/contracts/device-identity'
import { RemoteOperationReceiptSchema, RemoteOwnerControlSchema, RemoteTerminalEvidenceSchema, RemoteNativeIdentitySchema, RemoteInteractionTargetSchema, RemoteOwnerReconciliationSchema,
  type RemoteOperationReceipt, type RemoteOperationStatus, type RemoteOwnerControl,
  type RemoteInteractionTarget, type RemoteNativeIdentity, type RemoteTerminalEvidence, type RemoteOwnerReconciliation } from '@foreman-code/contracts/remote-execution'

import { RemoteJobOperationReceiptRecordSchema, RemoteJobDispatchIntentSchema, RemoteJobOwnerControlSchema, RemoteJobNativeIdentitySchema, RemoteJobTerminalEvidenceSchema,
  type RemoteJobConnectionIdentity, type RemoteJobOperationReceiptRecord, type RemoteJobDispatchIntent, type RemoteJobOwnerControl, type RemoteJobNativeIdentity, type RemoteJobTerminalEvidence, type RemoteJobOperationStatusRecord } from '@foreman-code/contracts/remote-job-execution'

import { JobRuntimeNativeAdmissionRecordSchema, JobQualificationCandidateRecordSchema, JobRuntimeQualificationResultRecordSchema,
  type JobRuntimeNativeAdmissionRecord, type JobQualificationCandidateRecord } from '@foreman-code/contracts/job-verification-runtime'
import { JobNativeOwnerSchema, JobOCICertificateSchema, isPreparatoryVerificationOwner, jobContainerNonEntryObserved, type JobNativeOwner } from '../../jobs/executorJournal.js'
import { jobSupervisorIdentity } from '../../jobs/executor.js'
import { QualificationReceiptSchema, QualificationOCICertificateSchema, qualificationCleanupCommandAllowed, qualificationCreationFailed,
  QUALIFICATION_COMMAND_LIMIT, QUALIFICATION_CLEANUP_COMMAND_LIMIT,
  type QualificationReceipt } from '../../jobs/qualificationJournal.js'

const JournalSchema = z.object({ schemaVersion: z.literal(1), jobOwners: z.array(JobNativeOwnerSchema).max(1000).default([]), qualificationReceipts: z.array(QualificationReceiptSchema).max(1000).default([]), receipts: z.array(z.union([RemoteOperationReceiptSchema, RemoteJobOperationReceiptRecordSchema])),
  reconciliations: z.array(RemoteOwnerReconciliationSchema).max(128), jobOutputs: z.array(z.object({ operationId: z.string(), commandId: z.uuid(), path: z.string(), mediaType: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), byteSize: z.number().int().nonnegative() }).strict()).default([]), jobLogs: z.array(z.object({ operationId: z.string(), acknowledgedSequence: z.number().int().nonnegative(), chunks: z.array(JobLogChunkSchema).max(4096) }).strict()).default([]) }).strict()
const same = isDeepStrictEqual
const JournalOwnerSchema = z.object({ schemaVersion: z.literal(1), token: z.uuid(),
  pid: z.number().int().positive(), startTicks: z.string().regex(/^\d+$/), bootId: z.uuid() }).strict()

function recoverJournalOwnerLock(path: string, assertExclusiveOwner: () => void, conflict: unknown) {
  assertExclusiveOwner()
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const file = fstatSync(descriptor)
    if (!file.isFile() || file.nlink !== 1 || file.mode & 0o077 || file.uid !== process.getuid!()
      || file.size < 1 || file.size > 4096) throw new Error('Journal owner lock is not private.')
    const contents = readFileSync(descriptor, 'utf8')
    let owner: unknown
    try { owner = JSON.parse(contents) } catch { owner = undefined }
    const recorded = JournalOwnerSchema.safeParse(owner)
    if (recorded.success) {
      if (recorded.data.bootId === bootIdentity() && identityAlive(recorded.data)) throw conflict
    } else if (!z.uuid().safeParse(contents).success) throw new Error('Journal owner lock requires recovery.')
    assertExclusiveOwner()
    const named = lstatSync(path)
    if (named.dev !== file.dev || named.ino !== file.ino || named.ctimeMs !== file.ctimeMs) {
      throw new Error('Journal owner lock changed during recovery.')
    }
    unlinkSync(path)
  } finally { closeSync(descriptor) }
}

/** Single worker owner; the caller must hold the worker installation's exclusive service lock.
 * Every mutating method fsyncs before returning authority to the native adapter.
 * No eviction: full journals reject new work, preserving unresolved ownership and terminal tombstones.
 */
export class RemoteOperationJournal {
  private closed = false
  private faulted = false
  private tail: Promise<unknown> = Promise.resolve()
  private constructor(private readonly path: string, private data: z.infer<typeof JournalSchema>, private readonly capacity: number, private readonly lock: FileHandle) {}
  static async open(path: string, options: { initializeNewInstallation?: boolean; capacity?: number;
    assertExclusiveOwner?: () => void } = {}) {
    const capacity = options.capacity ?? 1000
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('Invalid journal capacity')
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const lockPath = `${path}.owner-lock`
    let lock: FileHandle
    try { lock = await open(lockPath, 'wx', 0o600) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !options.assertExclusiveOwner) throw error
      recoverJournalOwnerLock(lockPath, options.assertExclusiveOwner, error)
      lock = await open(lockPath, 'wx', 0o600)
    }
    try {
      const identity = process.platform === 'linux' ? processIdentity(process.pid) : undefined
      const owner = identity ? { schemaVersion: 1, token: randomUUID(), pid: identity.pid,
        startTicks: identity.startTicks, bootId: bootIdentity() } : randomUUID()
      await lock.writeFile(typeof owner === 'string' ? owner : JSON.stringify(owner))
      await lock.sync()
      let data: z.infer<typeof JournalSchema>
      try {
        if ((await stat(path)).size > 4 * 1024 * 1024) throw new Error('Journal byte limit reached')
        const serialized = await readFile(path, 'utf8')
        if (Buffer.byteLength(serialized) > 4 * 1024 * 1024) throw new Error('Journal byte limit reached')
        data = JournalSchema.parse(JSON.parse(serialized))
      } catch (error) {
        if (!options.initializeNewInstallation || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Journal unavailable: recovery required', { cause: error })
        data = { schemaVersion: 1, receipts: [], qualificationReceipts: [], reconciliations: [], jobOutputs: [], jobLogs: [], jobOwners: [] }
      }
      if (data.receipts.length + data.qualificationReceipts.length > capacity) throw new Error('Journal exceeds capacity')
      const journal = new RemoteOperationJournal(path, data, capacity, lock)
      await journal.persist(data)
      return journal
    } catch (error) { await lock.close(); await unlink(`${path}.owner-lock`); throw error }
  }
  async close() {
    if (this.closed) return
    this.closed = true
    await this.tail
    this.faulted = true
    await this.lock.close()
    await unlink(`${this.path}.owner-lock`)
  }
  private async persist(data: z.infer<typeof JournalSchema>) {
    const serialized = JSON.stringify(JournalSchema.parse(data))
    if (Buffer.byteLength(serialized) > 4 * 1024 * 1024) throw new Error('Journal byte limit reached')
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${randomUUID()}.tmp`
    const file = await open(temporary, 'wx', 0o600)
    try { await file.writeFile(serialized); await file.sync() } catch (error) { await unlink(temporary); throw error } finally { await file.close() }
    await rename(temporary, this.path)
    const directory = await open(dirname(this.path), 'r')
    try { await directory.sync() } finally { await directory.close() }
  }
  private change<T>(apply: (data: z.infer<typeof JournalSchema>) => T): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Journal closed: recovery required'))
    const task = this.tail.then(async () => {
      if (this.faulted) throw new Error('Journal durability uncertain: recovery required')
      const next = structuredClone(this.data)
      const result = apply(next)
      try { await this.persist(next) } catch (error) { this.faulted = true; throw error }
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
    return receipt ? { status: 'known', receipt: structuredClone(receipt) } : { status: 'unknown', reason: 'journal_absence_requires_reconciliation' }
  }
  accept(intent: DispatchIntent, connection: DeviceConnectionIdentity, workerIncarnationId: string) {
    return this.change(data => {
      intent = DispatchIntentSchema.parse(intent)
      const existing = data.receipts.find(value => value.intent.operationId === intent.operationId)
      if (existing) {
        if ('kind' in existing) throw new Error('Operation subject conflict')
        if (!same(existing.intent, intent)) throw new Error('Operation binding conflict')
        return existing
      }
      if (data.receipts.some(value => value.intent.executionId === intent.executionId || value.intent.attemptId === intent.attemptId)) throw new Error('Execution attempt already bound to another operation')
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
    return this.change(data => {
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
    return this.change(data => {
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
    return this.change(data => {
      command = RemoteOwnerControlSchema.parse(command)
      const receipt = this.receipt(data, command.operationId)
      const prior = receipt.controls.find(value => value.commandId === command.commandId)
      if (prior) { if (!same(prior, command)) throw new Error('Control command conflict'); return { dispatch: false, receipt } }
      if (receipt.intent.attemptId !== command.attemptId || receipt.intent.executionId !== command.executionId
        || receipt.intent.bindingHash !== command.bindingHash || !same(receipt.intent.owner, command.owner)) throw new Error('Stale control ownership')
      if (command.nativeTarget && (command.nativeTarget.kind !== 'session' || command.nativeTarget.sessionId !== receipt.native?.sessionId
        || (command.nativeTarget.turnId && command.nativeTarget.turnId !== receipt.native?.turnId))) throw new Error('Wrong explicit native target')
      if (command.native && !same(command.native, receipt.native)) throw new Error('Wrong native control target')
      if (command.action.kind === 'respond') {
        const target = receipt.interaction
        if (receipt.stopFence || receipt.phase !== 'running' || !target || target.interactionId !== command.action.interactionId
          || target.interactionRevision !== command.action.interactionRevision || target.nativeInteractionId !== command.action.nativeInteractionId) throw new Error('Response is not currently eligible')
        if (receipt.controls.some(value => value.action.kind === 'respond' && value.action.nativeInteractionId === target.nativeInteractionId
          && value.native?.sessionId === target.native.sessionId && value.native?.turnId === target.native.turnId)) throw new Error('Interaction response already reserved')
      }
      if (receipt.controls.length >= 128) throw new Error('Control journal full')
      receipt.controls.push(command)
      if (command.action.kind === 'stop') { receipt.stopFence = true; if (receipt.phase !== 'confirmed_terminal') receipt.phase = 'stop_requested' }
      receipt.sequence++
      return { dispatch: receipt.phase !== 'confirmed_terminal' && receipt.native !== undefined, receipt }
    })
  }
  revokeFence(operationId: string) {
    return this.change(data => {
      const receipt = this.receipt(data, operationId)
      if (receipt.phase !== 'confirmed_terminal') {
        receipt.stopFence = true; receipt.phase = 'stop_requested'; receipt.uncertainty = 'Authority revoked; physical closure pending'; receipt.sequence++
      }
      return receipt
    })
  }
  uncertain(operationId: string, reason: string) {
    return this.change(data => {
      const receipt = this.receipt(data, operationId)
      if (receipt.phase !== 'confirmed_terminal') { receipt.phase = 'uncertain'; receipt.uncertainty = reason.slice(0, 500); receipt.sequence++ }
      return receipt
    })
  }
  terminal(operationId: string, evidence: RemoteTerminalEvidence) {
    return this.change(data => {
      const receipt = this.receipt(data, operationId)
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
  async pendingQualifications(): Promise<QualificationReceipt[]> {
    await this.tail
    if (this.faulted) throw new Error('Journal durability uncertain: recovery required')
    return structuredClone(this.data.qualificationReceipts.filter(receipt =>
      receipt.phase !== 'closed' || !receipt.result || receipt.quotaClaims.length))
  }
  async assertRuntimeQuiescent(): Promise<void> {
    await this.tail
    if (this.faulted) throw new Error('Journal durability uncertain: recovery required')
    const qualificationPending = this.data.qualificationReceipts.some(receipt =>
      receipt.phase !== 'closed' || !receipt.result || receipt.quotaClaims.length)
    const executionPending = this.data.receipts.some(receipt => receipt.phase !== 'confirmed_terminal'
      || 'kind' in receipt && receipt.publication !== 'complete'
        && !(receipt.publication === 'failed' && this.data.jobOwners.some(owner =>
          owner.operationId === receipt.intent.operationId && owner.sourceReclamation)))
    const nativePending = this.data.jobOwners.some(owner => owner.launches.some(launch => !launch.closed)
      || owner.container && owner.container.certificate?.lifecycle !== 'closed'
        && !(owner.nonEntryConfirmed && jobContainerNonEntryObserved(owner))
      || owner.verification && !owner.verification.finalizedAt && !owner.sourceReclamation)
    if (qualificationPending || executionPending || nativePending) {
      throw new Error('Installed runtime still has unfinished work.')
    }
  }
  async qualificationStatus(operationId: string): Promise<QualificationReceipt | null> {
    await this.tail
    if (this.faulted) throw new Error('Journal durability uncertain: recovery required')
    return structuredClone(this.data.qualificationReceipts.find(value => value.admission.operationId === operationId) ?? null)
  }
  qualificationAccept(raw: JobRuntimeNativeAdmissionRecord, rawCandidate: JobQualificationCandidateRecord) {
    return this.change(data => {
      const admission = JobRuntimeNativeAdmissionRecordSchema.parse(raw)
      const candidate = JobQualificationCandidateRecordSchema.parse(rawCandidate)
      if (candidate.operationId !== admission.operationId || candidate.approvalId !== admission.approvalId || candidate.qualificationId !== admission.qualificationId) throw new Error('Qualification candidate subject changed')
      const existing = data.qualificationReceipts.find(value => value.admission.operationId === admission.operationId)
      if (existing) { if (!same(existing.admission, admission) || !same(existing.candidate, candidate)) throw new Error('Qualification admission conflict'); return existing }
      if (data.receipts.some(value => value.intent.operationId === admission.operationId) || data.qualificationReceipts.some(value =>
        value.admission.approvalId === admission.approvalId || value.admission.leaseId === admission.leaseId)) throw new Error('Original qualification identity already bound')
      if (data.qualificationReceipts.length >= 1000 || data.receipts.length + data.qualificationReceipts.length >= this.capacity) throw new Error('Journal full: explicit retention disposition required')
      if (Date.parse(admission.expiresAt) <= Date.now()) throw new Error('Qualification admission expired')
      const receipt = QualificationReceiptSchema.parse({ admission, candidate, result: null, sequence: 1, phase: 'received', launches: [], container: null, quotaClaims: [] })
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
  qualificationReleaseQuotaClaims(operationId: string) {
    return this.change(data => {
      const receipt = this.qualificationReceipt(data, operationId)
      if (receipt.phase !== 'closed') throw new Error('Positive closure required before releasing quota ownership')
      receipt.quotaClaims = []
      receipt.sequence++
      return receipt
    })
  }
  qualificationQuotaClaim(operationId: string, claim: { path: string; namespace: string; device: number; inode: number }) {
    return this.change(data => {
      const receipt = this.qualificationReceipt(data, operationId)
      const saved = receipt.quotaClaims.find(value => value.path === claim.path)
      if (saved) {
        if (!same(saved, claim)) throw new Error('Original qualification quota claim changed')
        return receipt
      }
      if (receipt.phase !== 'native_entry_attempted') throw new Error('Qualification quota claim requires original entry')
      receipt.quotaClaims.push(claim)
      receipt.sequence++
      return receipt
    })
  }
  qualificationReserveCleanupProcess(operationId: string, input: { launchId: string; binary: string; argv: string[] }) {
    return this.change(data => {
      const receipt = this.qualificationReceipt(data, operationId)
      const permitted = qualificationCleanupCommandAllowed(receipt, input.binary, input.argv)
      if (!permitted || !['native_entry_attempted', 'uncertain'].includes(receipt.phase)
        || receipt.launches.some(value => !value.closed || value.launchId === input.launchId)
        || receipt.launches.length >= QUALIFICATION_CLEANUP_COMMAND_LIMIT) {
        throw new Error('Original qualification cleanup reservation unavailable')
      }
      receipt.launches.push({ ...input, exit: null, closed: false })
      receipt.sequence++
      return receipt
    })
  }
  qualificationReserveProcess(operationId: string, input: { launchId: string; binary: string; argv: string[] }) {
    return this.change(data => {
      const receipt = this.qualificationReceipt(data, operationId)
      if (receipt.phase !== 'native_entry_attempted' || receipt.launches.some(value => value.launchId === input.launchId) ||
        receipt.launches.some(value => !value.closed) || receipt.launches.length >= QUALIFICATION_COMMAND_LIMIT) {
        throw new Error('Original qualification process reservation unavailable')
      }
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
      if (!(identity === `graphql-ci-qualification-${receipt.admission.qualificationId}`
        || receipt.candidate.fingerprint.schemaVersion === 3
          && identity.startsWith(`graphql-ci-qualification-${receipt.admission.qualificationId}-`)) || fingerprint !== receipt.admission.fingerprintDigest ||
        receipt.phase !== 'native_entry_attempted') throw new Error('Original qualification container intent changed')
      if (receipt.container) {
        if (receipt.container.identity === identity && receipt.container.fingerprint === fingerprint) return receipt
        if (receipt.container.certificate?.lifecycle !== 'closed' || receipt.closedContainers.length >= 16) {
          throw new Error('Original qualification container is still active.')
        }
        receipt.closedContainers.push(receipt.container.certificate)
      }
      receipt.container = { identity, fingerprint, containerId: null, certificate: null }; receipt.creationAbsent = false; receipt.sequence++; return receipt
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
        if (receipt.launches.some(value => !value.closed) || receipt.container && receipt.container.certificate?.lifecycle !== 'closed'
          && !(receipt.creationAbsent && qualificationCreationFailed(receipt))) throw new Error('Original physical qualification closure unconfirmed')
        receipt.phase = 'closed'; receipt.sequence++
      }
      return receipt
    })
  }
  qualificationCreationAbsent(operationId: string, identity: string) {
    return this.change(data => {
      const receipt = this.qualificationReceipt(data, operationId)
      const observation = receipt.launches.at(-1)
      if (receipt.container?.identity !== identity || !qualificationCreationFailed(receipt)
        || !observation || !same(observation.argv, ['--remote=false', 'container', 'exists', identity])
        || observation.exit?.exitCode !== 1 || observation.exit.signal !== null) {
        throw new Error('Original failed container creation is unconfirmed')
      }
      receipt.creationAbsent = true; receipt.sequence++; return receipt
    })
  }
  qualificationConfirmNonEntry(operationId: string) {
    return this.change(data => {
      const receipt = this.qualificationReceipt(data, operationId)
      if (receipt.phase !== 'received' || receipt.launches.length || receipt.container || receipt.quotaClaims.length) {
        throw new Error('Qualification native non-entry is unconfirmed')
      }
      receipt.phase = 'closed'
      receipt.sequence++
      return receipt
    })
  }
  qualificationResult(operationId: string, raw: unknown) {
    return this.change(data => {
      const receipt = this.qualificationReceipt(data, operationId), result = JobRuntimeQualificationResultRecordSchema.parse(raw)
      if (receipt.result) {
        const reconciled = receipt.phase === 'closed' && receipt.result.outcome === 'denied'
          && receipt.result.closure === 'unconfirmed' && result.outcome === 'denied' && result.closure === 'confirmed'
          && same({ ...receipt.result, closure: 'confirmed' }, result)
        if (reconciled) { receipt.result = result; receipt.sequence++; return receipt }
        if (!same(receipt.result, result)) throw new Error('Original qualification result changed')
        return receipt
      }
      if (result.outcome === 'qualified') {
        const identity = result.measurement.schemaVersion === 2 ? result.measurement.identity : result.measurement
        if (receipt.phase !== 'closed' || receipt.container?.certificate?.lifecycle !== 'closed'
          || identity.approvalId !== receipt.admission.approvalId
          || identity.qualificationId !== receipt.admission.qualificationId
          || identity.fingerprintDigest !== receipt.admission.fingerprintDigest
          || !same(result.measurement.fingerprint, receipt.candidate.fingerprint)) {
          throw new Error('Original measured qualification closure/context missing')
        }
      }
      if (result.outcome === 'denied' && result.closure === 'confirmed' && receipt.phase !== 'closed') throw new Error('Original physical qualification closure unconfirmed')
      if (result.outcome === 'denied' && result.closure === 'unconfirmed') receipt.phase = 'uncertain'
      receipt.result = result; receipt.sequence++; return receipt
    })
  }

  private jobReceipt(data: z.infer<typeof JournalSchema>, operationId: string) {
    const receipt = data.receipts.find((value): value is RemoteJobOperationReceiptRecord => 'kind' in value && value.intent.operationId === operationId)
    if (!receipt) throw new Error('Unknown job operation: recovery required')
    return receipt
  }
  async jobStatus(operationId: string): Promise<RemoteJobOperationStatusRecord> {
    await this.tail
    if (this.faulted) throw new Error('Journal durability uncertain: recovery required')
    const receipt = this.data.receipts.find((value): value is RemoteJobOperationReceiptRecord => 'kind' in value && value.intent.operationId === operationId)
    return receipt ? { status: 'known', receipt: structuredClone(receipt) } : { status: 'unknown', reason: 'journal_absence_requires_reconciliation' }
  }
  async jobOperations(): Promise<RemoteJobOperationReceiptRecord[]> {
    await this.tail
    if (this.faulted) throw new Error('Journal durability uncertain: recovery required')
    return structuredClone(this.data.receipts.filter((receipt): receipt is RemoteJobOperationReceiptRecord => 'kind' in receipt))
  }
  async jobCancellationConnection(execution: JobExecutionRecord): Promise<RemoteJobConnectionIdentity> {
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
      const fingerprint = measurement.fingerprint
      const matchingKind = execution.schemaVersion === 2
        ? measurement.schemaVersion === 2 && same(measurement.identity, execution.acceptedSpec.profile)
        : measurement.schemaVersion === 1
      return matchingKind && fingerprint.profileId === spec.policy.isolationPolicyId
        && fingerprint.profileRevision === spec.policy.isolationPolicyRevision
        && fingerprint.imageDigest === spec.policy.imageDigest
        && fingerprint.toolchainDigest === spec.policy.toolchainDigest
        && same(fingerprint.hostRef, spec.target.hostRef) && same(fingerprint.registration, spec.target.registration)
        && fingerprint.mainInstallationId === spec.target.mainInstallationId
        && fingerprint.root.binding.workspaceId === execution.workspaceId
        && fingerprint.root.selection.rootPolicyId === spec.target.destination.rootPolicyId
        && fingerprint.root.selection.rootPolicyRevision === spec.target.destination.rootPolicyRevision
    })
    if (matches.length !== 1) throw new Error('Original Job connection missing or ambiguous')
    return structuredClone(matches[0]!.admission.connection!)
  }
  jobCancelBeforeEntry(intent: RemoteJobDispatchIntent, raw: JobExecutionRecord, connection: RemoteJobConnectionIdentity,
    workerIncarnationId: string, command: RemoteJobOwnerControl, rawTerminal: RemoteJobTerminalEvidence) {
    return this.change(data => {
      const execution = JobExecutionRecordSchema.parse(raw)
      const terminal = RemoteJobTerminalEvidenceSchema.parse(rawTerminal)
      if (terminal.outcome !== 'cancelled' || terminal.exitCode !== null || terminal.signal !== null
        || !terminal.processStopped) throw new Error('No-entry cancellation terminal required')
      if (intent.executionId !== execution.id || intent.attemptId !== execution.attemptId
        || intent.operationId !== execution.operationId || intent.bindingHash !== execution.acceptedSpec.bindingHash
        || intent.inputDigest !== `sha256:${execution.acceptedSpec.specDigest}` || !same(intent.owner, execution.owner)) {
        throw new Error('Job cancellation execution ownership mismatch')
      }
      const owner = data.jobOwners.find(value => value.operationId === intent.operationId)
      if (owner && (!isPreparatoryVerificationOwner(owner, execution) || !same(owner.connection, connection))) {
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
  jobAccept(raw: RemoteJobDispatchIntent, execution: JobExecutionRecord, connection: RemoteJobConnectionIdentity, workerIncarnationId: string) {
    return this.change(data => this.acceptJob(data, raw, execution, connection, workerIncarnationId))
  }
  private acceptJob(data: z.infer<typeof JournalSchema>, raw: RemoteJobDispatchIntent, execution: JobExecutionRecord,
    connection: RemoteJobConnectionIdentity, workerIncarnationId: string) {
      const intent = RemoteJobDispatchIntentSchema.parse(raw)
      const existing = data.receipts.find(value => value.intent.operationId === intent.operationId)
      if (existing) {
        if (!('kind' in existing) || !same(existing.intent, intent)) throw new Error('Job operation binding conflict')
        return existing
      }
      if (data.receipts.some(value => value.intent.executionId === intent.executionId || value.intent.attemptId === intent.attemptId)) throw new Error('Execution attempt already bound to another operation')
      if (data.qualificationReceipts.some(value => value.admission.operationId === intent.operationId)) throw new Error('Operation already bound to a qualification')
      if (data.receipts.length + data.qualificationReceipts.length >= this.capacity) throw new Error('Journal full: explicit retention disposition required')
      if (connection.mainId !== intent.mainId) throw new Error('Wrong main identity')
      const receipt = RemoteJobOperationReceiptRecordSchema.parse({ schemaVersion: 1, kind: 'job', intent, execution, connection, workerIncarnationId,
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
    return this.change(data => this.recordJobControl(data, raw))
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
      const owner = data.jobOwners.find(value => value.operationId === operationId)
      if (receipt.entryAttempted && !receipt.native && !(owner?.nonEntryConfirmed && jobContainerNonEntryObserved(owner))) {
        throw new Error('Attempted OCI entry requires original container reconciliation')
      }
      receipt.terminal = evidence; receipt.phase = 'confirmed_terminal'; receipt.sequence++; receipt.observedAt = new Date().toISOString(); return receipt
    })
  }
  jobConfirmContainerNonEntry(operationId: string, runtimeExecutable: string) {
    return this.change(data => {
      const receipt = this.jobReceipt(data, operationId)
      const owner = data.jobOwners.find(value => value.operationId === operationId)
      if (receipt.native || !owner || !same(owner.connection, receipt.connection)
        || !jobContainerNonEntryObserved(owner) || owner.launches.some(launch => launch.binary !== runtimeExecutable)) {
        throw new Error('Original Job container non-entry is unconfirmed')
      }
      owner.nonEntryConfirmed = true; receipt.sequence++; return owner
    })
  }
  jobPublication(operationId: string, phase: RemoteJobOperationReceiptRecord['publication']) {
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
  async qualifiedJobRuntime(execution: JobExecutionRecord): Promise<QualificationReceipt> {
    await this.tail
    if (this.faulted) throw new Error('Journal durability uncertain: recovery required')
    const spec = execution.acceptedSpec
    const retained = this.data.jobOwners.find(value => value.operationId === execution.operationId)?.qualificationOperationId
    const matches = this.data.qualificationReceipts.flatMap(receipt => {
      if (receipt.phase !== 'closed' || receipt.result?.outcome !== 'qualified') return []
      const measurement = receipt.result.measurement
      const fingerprint = measurement.fingerprint
      const root = fingerprint.root
      let matching = (!retained || receipt.admission.operationId === retained)
        && fingerprint.profileId === spec.policy.isolationPolicyId
        && fingerprint.profileRevision === spec.policy.isolationPolicyRevision
        && fingerprint.imageDigest === spec.policy.imageDigest
        && fingerprint.toolchainDigest === spec.policy.toolchainDigest
        && same(fingerprint.hostRef, spec.target.hostRef)
        && same(fingerprint.registration, spec.target.registration)
        && fingerprint.mainInstallationId === spec.target.mainInstallationId
        && root.binding.workspaceId === execution.workspaceId
        && root.selection.rootPolicyId === spec.target.destination.rootPolicyId
        && root.selection.rootPolicyRevision === spec.target.destination.rootPolicyRevision
        && root.selection.locationRevision === spec.target.destination.locationRevision
        && same(fingerprint, receipt.candidate.fingerprint)
        && (Boolean(retained) || Date.parse(measurement.expiresAt) > Date.now())
      if ('verification' in spec) {
        matching = matching && measurement.schemaVersion === 2 && same(measurement.identity, spec.profile)
      } else matching = matching && measurement.schemaVersion === 1
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
      owner = { operationId, qualificationOperationId: null, timedOut: false, nonEntryConfirmed: false, connection: receipt.connection, launches: [], container: null }
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
  jobReleasePreparatoryOwner(operationId: string, scope: {
    executionId: string; attemptId: string; bindingHash: string; materializationId: string; closureEvidenceDigest: string
  }) {
    return this.change(data => {
      const receipt = this.jobReceipt(data, operationId)
      const execution = receipt.execution
      if (receipt.entryAttempted || receipt.native || !receipt.stopFence || !receipt.terminal?.processStopped
        || receipt.terminal.outcome !== 'cancelled' || receipt.terminal.closureEvidenceDigest !== scope.closureEvidenceDigest
        || execution.id !== scope.executionId || execution.attemptId !== scope.attemptId
        || execution.acceptedSpec.bindingHash !== scope.bindingHash
        || execution.acceptedSpec.source.materializationId !== scope.materializationId) {
        throw new Error('Original positively closed before-entry scope required for owner retirement.')
      }
      const owner = data.jobOwners.find(value => value.operationId === operationId)
      if (!owner) return
      if (!isPreparatoryVerificationOwner(owner, execution) || !same(owner.connection, receipt.connection)) {
        throw new Error('Original Job native entry owner requires physical reconciliation')
      }
      data.jobOwners = data.jobOwners.filter(value => value.operationId !== operationId)
    })
  }
  jobPrepareVerification(operationId: string, raw: NonNullable<JobNativeOwner['verification']>) {
    return this.change(data => {
      const receipt = this.jobReceipt(data, operationId)
      if (receipt.execution.schemaVersion !== 2 || receipt.entryAttempted || receipt.stopFence || receipt.terminal) {
        throw new Error('Verification preparation requires the original unentered operation.')
      }
      const preparation = JobNativeOwnerSchema.shape.verification.unwrap().parse(raw)
      const spec = receipt.execution.acceptedSpec
      if (preparation.context.identity.executionId !== receipt.execution.id
        || preparation.context.identity.attemptId !== receipt.execution.attemptId
        || preparation.context.identity.commit !== spec.source.commit
        || preparation.context.identity.definitionVersionId !== spec.definitionVersionId
        || !same(preparation.context.identity.profile, spec.profile)
        || !same(preparation.context.identity.resources, spec.verification.resources)
        || preparation.reserve.bytes !== spec.verification.resources.reportBytes) {
        throw new Error('Verification preparation changed its original accepted facts.')
      }
      let owner = data.jobOwners.find(value => value.operationId === operationId)
      if (!owner) {
        owner = { operationId, qualificationOperationId: null, timedOut: false,
          connection: receipt.connection, launches: [], container: null }
        data.jobOwners.push(owner)
      }
      if (!same(owner.connection, receipt.connection) || owner.verification && !same(owner.verification, preparation)) {
        throw new Error('Original verification preparation conflicts with retained state.')
      }
      owner.verification ??= preparation
      return owner.verification
    })
  }
  jobVerificationFinalized(operationId: string, finishedAt: string) {
    return this.change(data => {
      const receipt = this.jobReceipt(data, operationId)
      const owner = this.jobOwner(data, operationId)
      if (!receipt.terminal?.processStopped || receipt.terminal.finishedAt !== finishedAt || !owner.verification) {
        throw new Error('Original closed verification and terminal time required for finalization.')
      }
      if (owner.verification.finalizedAt && owner.verification.finalizedAt !== finishedAt) {
        throw new Error('Verification finalization time changed.')
      }
      owner.verification.finalizedAt ??= finishedAt
    })
  }
  jobSourceReclaimed(operationId: string, raw: SourcePreparationClosure) {
    return this.change(data => {
      const closure = SourcePreparationClosureSchema.parse(raw)
      const receipt = this.jobReceipt(data, operationId), owner = this.jobOwner(data, operationId)
      const execution = receipt.execution, target = execution.acceptedSpec.target
      if (execution.schemaVersion !== 2 || receipt.phase !== 'confirmed_terminal'
        || !receipt.terminal?.processStopped || !['complete', 'failed'].includes(receipt.publication)
        || closure.quotaReclaimed !== true || closure.operationId !== operationId
        || closure.executionId !== execution.id || closure.attemptId !== execution.attemptId
        || closure.mainId !== target.mainId || closure.deviceId !== (target.hostRef.kind === 'device' ? target.hostRef.deviceId : null)
        || closure.workerInstallationId !== (target.registration?.workerInstallationId ?? null)
        || closure.keyRevision !== (target.registration?.keyRevision ?? null)
        || closure.authorizationRevision !== (target.registration?.authorizationRevision ?? null)
        || closure.materializationId !== execution.acceptedSpec.source.materializationId
        || receipt.native && !owner.container
        || owner.launches.some(launch => !launch.closed)
        || owner.container && owner.container.certificate?.lifecycle !== 'closed'
          && !(owner.nonEntryConfirmed && jobContainerNonEntryObserved(owner))) {
        throw new Error('Original stopped Job and reclaimed quota closure required.')
      }
      owner.sourceReclamation ??= closure
    })
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
      const spec = this.jobReceipt(data, operationId).execution.acceptedSpec
      container.deadlineAt ??= 'verification' in spec ? spec.lifecycle.executionDeadlineAt
        : new Date(Date.now() + spec.policy.executionTimeoutMs).toISOString()
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
