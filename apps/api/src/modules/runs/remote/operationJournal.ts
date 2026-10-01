import { open, readFile, rename, mkdir, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { DispatchIntentSchema, type DispatchIntent } from '@graphql/contracts/node-placement'
import type { DeviceConnectionIdentity } from '@graphql/contracts/device-identity'
import { RemoteOperationReceiptSchema, RemoteOwnerControlSchema, RemoteTerminalEvidenceSchema, RemoteNativeIdentitySchema, RemoteInteractionTargetSchema,
  type RemoteOperationStatus, type RemoteOwnerControl,
  type RemoteInteractionTarget, type RemoteNativeIdentity, type RemoteTerminalEvidence, type RemoteOwnerReconciliation } from '@graphql/contracts/remote-execution'

const JournalSchema = z.object({ schemaVersion: z.literal(1), receipts: z.array(RemoteOperationReceiptSchema),
  reconciliations: z.array(z.object({ commandId: z.string(), operationId: z.string(), previousOwner: z.object({ grantId: z.string(), epoch: z.string() }),
    nextOwner: z.object({ grantId: z.string(), epoch: z.string() }), native: RemoteNativeIdentitySchema, evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(128) }).strict()
const same = isDeepStrictEqual

/** Single worker owner; the caller must hold the worker installation's exclusive service lock.
 * Every mutating method fsyncs before returning authority to the native adapter.
 * No eviction: full journals reject new work, preserving unresolved ownership and terminal tombstones.
 */
export class RemoteOperationJournal {
  private faulted = false
  private tail: Promise<unknown> = Promise.resolve()
  private constructor(private readonly path: string, private data: z.infer<typeof JournalSchema>, private readonly capacity: number, private readonly lock: FileHandle) {}
  static async open(path: string, options: { initializeNewInstallation?: boolean; capacity?: number } = {}) {
    const capacity = options.capacity ?? 1000
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('Invalid journal capacity')
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    // A crashed owner leaves a fence. W11/operator reconciliation must establish safe lock disposition.
    const lock = await open(`${path}.owner-lock`, 'wx', 0o600)
    try {
      await lock.writeFile(randomUUID()); await lock.sync()
      let data: z.infer<typeof JournalSchema>
      try {
        const serialized = await readFile(path, 'utf8')
        if (Buffer.byteLength(serialized) > 4 * 1024 * 1024) throw new Error('Journal byte limit reached')
        data = JournalSchema.parse(JSON.parse(serialized))
      } catch (error) {
        if (!options.initializeNewInstallation || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Journal unavailable: recovery required', { cause: error })
        data = { schemaVersion: 1, receipts: [], reconciliations: [] }
      }
      if (data.receipts.length > capacity) throw new Error('Journal exceeds capacity')
      const journal = new RemoteOperationJournal(path, data, capacity, lock)
      await journal.persist(data)
      return journal
    } catch (error) { await lock.close(); await unlink(`${path}.owner-lock`); throw error }
  }
  async close() {
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
    const receipt = data.receipts.find(value => value.intent.operationId === operationId)
    if (!receipt) throw new Error('Unknown operation: recovery required')
    return receipt
  }
  async status(operationId: string): Promise<RemoteOperationStatus> {
    await this.tail
    if (this.faulted) throw new Error('Journal durability uncertain: recovery required')
    const receipt = this.data.receipts.find(value => value.intent.operationId === operationId)
    return receipt ? { status: 'known', receipt: structuredClone(receipt) } : { status: 'unknown', reason: 'journal_absence_requires_reconciliation' }
  }
  accept(intent: DispatchIntent, connection: DeviceConnectionIdentity, workerIncarnationId: string) {
    return this.change(data => {
      intent = DispatchIntentSchema.parse(intent)
      const existing = data.receipts.find(value => value.intent.operationId === intent.operationId)
      if (existing) {
        if (!same(existing.intent, intent)) throw new Error('Operation binding conflict')
        return existing
      }
      if (data.receipts.length >= this.capacity) throw new Error('Journal full: explicit retention disposition required')
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
        if (receipt.controls.some(value => value.action.kind === 'respond' && value.action.interactionId === target.interactionId
          && value.action.interactionRevision === target.interactionRevision)) throw new Error('Interaction response already reserved')
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
      const prior = data.reconciliations.find(value => value.commandId === transition.commandId)
      if (prior) { if (!same(prior, transition)) throw new Error('Reconciliation command conflict'); return this.receipt(data, transition.operationId) }
      const receipt = this.receipt(data, transition.operationId)
      if (!same(receipt.intent.owner, transition.previousOwner) || !same(receipt.native, transition.native)
        || !/^[a-f0-9]{64}$/.test(transition.evidenceDigest) || BigInt(transition.nextOwner.epoch) <= BigInt(transition.previousOwner.epoch)) throw new Error('Original execution reconciliation evidence required')
      if (data.reconciliations.length >= 128) throw new Error('Reconciliation journal full')
      data.reconciliations.push(structuredClone(transition)); receipt.intent.owner = transition.nextOwner; receipt.sequence++; return receipt
    })
  }
}
