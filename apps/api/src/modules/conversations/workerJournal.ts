import { isDeepStrictEqual } from 'node:util'
import type { CompactionState, ExecutionResult, NativeSessionReference, SessionPreferences } from '@graphql/contracts'
import type { NativeMessageSubmission } from '@graphql/contracts/claude'
import type { DeviceSessionBinding } from '@graphql/contracts/device-connection'
import type { RemoteNativeIdentity } from '@graphql/contracts/remote-execution'
import type { WorkerConversationBinding, WorkerConversationReceipt } from '@graphql/contracts/remote-execution-rpc'
import { DomainError } from '../errors.js'

interface ConversationStore {
  read(): Promise<WorkerConversationReceipt[]>
  change<T>(apply: (records: WorkerConversationReceipt[]) => T): Promise<T>
}
function conflict(message: string): never {
  throw new DomainError('WORKER_CONVERSATION_CONFLICT', message, 409)
}
function addressed(records: WorkerConversationReceipt[], binding: WorkerConversationBinding) {
  const record = records.find(value => value.binding.owner.conversationId === binding.owner.conversationId)
  if (!record || !isDeepStrictEqual(record.binding, binding)) return conflict('The original conversation binding changed.')
  return record
}
function writable(record: WorkerConversationReceipt) {
  if (record.closed || record.closing) conflict('The native conversation is closing or closed.')
}
function unsettled(record: WorkerConversationReceipt) {
  return record.turns.some(turn => turn.status !== 'completed')
    || record.compactions.some(control => ['accepted', 'running', 'uncertain'].includes(control.state.status))
}

/** Stores chat ownership in the worker's existing fsynced operation journal. */
export class WorkerConversationJournal {
  constructor(private readonly store: ConversationStore, private readonly capacity: number) {}

  async read(binding: WorkerConversationBinding) {
    const record = (await this.store.read()).find(value =>
      value.binding.owner.conversationId === binding.owner.conversationId)
    if (record && !isDeepStrictEqual(record.binding, binding)) conflict('The original conversation binding changed.')
    return record
  }

  receive(binding: WorkerConversationBinding, connection: DeviceSessionBinding) {
    return this.store.change(records => {
      const original = records.find(value => value.binding.owner.conversationId === binding.owner.conversationId)
      if (original) {
        if (!isDeepStrictEqual(original.binding, binding)) conflict('The conversation already has another owner.')
        return original
      }
      if (records.length >= this.capacity) conflict('The worker conversation journal is full.')
      const record: WorkerConversationReceipt = { binding, connection, revision: 1, closing: false, closed: false,
        turns: [], compactions: [], desiredPreferences: null, appliedPreferences: null }
      records.push(record)
      return record
    })
  }

  private change<T>(binding: WorkerConversationBinding, apply: (record: WorkerConversationReceipt) => T) {
    return this.store.change(records => {
      const record = addressed(records, binding)
      const result = apply(record)
      record.revision++
      return result
    })
  }

  reserveCreation(binding: WorkerConversationBinding, operationId: string, inputHash: string) {
    return this.change(binding, record => {
      writable(record)
      if (record.creation) {
        if (record.creation.operationId !== operationId || record.creation.inputHash !== inputHash) {
          conflict('Native creation has already been reserved for another request.')
        }
        return { dispatch: false, record }
      }
      if (record.session) conflict('This conversation already has a native session.')
      record.creation = { operationId, inputHash }
      return { dispatch: true, record }
    })
  }

  bindSession(binding: WorkerConversationBinding, session: NativeSessionReference, nativeOwner: RemoteNativeIdentity) {
    return this.change(binding, record => {
      if (!record.creation || session.harness !== binding.harness || nativeOwner.sessionId !== session.nativeSessionId) {
        conflict('The native session does not match its conversation reservation.')
      }
      if (record.session && !isDeepStrictEqual(record.session, session)
        || record.nativeOwner && !isDeepStrictEqual(record.nativeOwner, nativeOwner)) {
        conflict('A different native session cannot replace this conversation.')
      }
      record.session = session
      record.nativeOwner = nativeOwner
      return record
    })
  }

  rebind(binding: WorkerConversationBinding, connection: DeviceSessionBinding, nativeOwner: RemoteNativeIdentity) {
    return this.change(binding, record => {
      if (!isDeepStrictEqual(record.nativeOwner, nativeOwner)) conflict('The original native owner was not recovered.')
      record.connection = connection
      return record
    })
  }

  reserveTurn(binding: WorkerConversationBinding, correlationId: string, inputHash: string) {
    return this.change(binding, record => {
      writable(record)
      const original = record.turns.find(turn => turn.correlationId === correlationId)
      if (original) {
        if (original.inputHash !== inputHash) conflict('The original turn input changed.')
        return { dispatch: false, record }
      }
      if (unsettled(record)) conflict('Recover the pending native operation before sending another turn.')
      if (record.turns.length >= 1000) conflict('The conversation turn journal is full.')
      record.turns.push({ correlationId, inputHash, status: 'reserved', nativeTurnId: null })
      return { dispatch: true, record }
    })
  }

  submitted(binding: WorkerConversationBinding, correlationId: string,
    identity: { nativeTurnId?: string; nativeSubmission?: NativeMessageSubmission }) {
    return this.change(binding, record => {
      const turn = record.turns.find(value => value.correlationId === correlationId)
      if (!turn || !record.session) conflict('The native input has no conversation reservation.')
      if (identity.nativeTurnId) {
        if (turn.nativeTurnId && turn.nativeTurnId !== identity.nativeTurnId) conflict('The native turn identity changed.')
        turn.nativeTurnId = identity.nativeTurnId
      }
      if (identity.nativeSubmission) {
        if (identity.nativeSubmission.nativeSessionId !== record.session.nativeSessionId
          || identity.nativeSubmission.clientCorrelationId !== correlationId
          || turn.nativeSubmission && !isDeepStrictEqual(turn.nativeSubmission, identity.nativeSubmission)) {
          conflict('The native message does not belong to this conversation turn.')
        }
        turn.nativeSubmission = identity.nativeSubmission
      }
      if (turn.status !== 'completed') turn.status = 'submitted'
      return record
    })
  }

  finishTurn(binding: WorkerConversationBinding, correlationId: string, result?: ExecutionResult) {
    return this.change(binding, record => {
      const turn = record.turns.find(value => value.correlationId === correlationId)
      if (!turn) conflict('The native turn has no conversation reservation.')
      if (turn.result && result && !isDeepStrictEqual(turn.result, result)) conflict('The native turn result changed.')
      if (result) {
        turn.result = result
        turn.status = 'completed'
      } else if (turn.status !== 'completed') turn.status = 'uncertain'
      return record
    })
  }

  reserveCompact(binding: WorkerConversationBinding, requestId: string, inputHash: string) {
    return this.change(binding, record => {
      writable(record)
      if (!record.session) conflict('The native conversation session is unavailable.')
      const original = record.compactions.find(control => control.state.requestId === requestId)
      if (original) {
        if (original.inputHash !== inputHash) conflict('The original compaction input changed.')
        return { dispatch: false, state: original.state }
      }
      if (unsettled(record)) conflict('Recover the pending native operation before compacting.')
      if (record.compactions.length >= 1000) conflict('The conversation control journal is full.')
      const state: CompactionState = { requestId, nativeSessionId: record.session.nativeSessionId,
        nativeOperationId: null, status: 'accepted', dispatchPhase: 'reserved',
        beforeTokens: null, observedAt: new Date().toISOString(), message: 'Native compaction is pending.' }
      record.compactions.push({ inputHash, state })
      return { dispatch: true, state }
    })
  }

  compactProgress(binding: WorkerConversationBinding, state: CompactionState) {
    return this.change(binding, record => {
      const control = record.compactions.find(value => value.state.requestId === state.requestId)
      if (!control || record.session?.nativeSessionId !== state.nativeSessionId) {
        conflict('The compaction does not belong to this native conversation.')
      }
      if (['completed', 'failed', 'no-op'].includes(control.state.status) && control.state.status !== state.status
        || control.state.nativeOperationId && state.nativeOperationId !== control.state.nativeOperationId) {
        conflict('The original native compaction outcome changed.')
      }
      control.state = state
      return state
    })
  }

  preferences(binding: WorkerConversationBinding, desired: SessionPreferences, applied: SessionPreferences | null) {
    return this.change(binding, record => {
      writable(record)
      record.desiredPreferences = desired
      record.appliedPreferences = applied
      return record
    })
  }

  closeRequested(binding: WorkerConversationBinding) {
    return this.change(binding, record => { record.closing = true; return record })
  }

  closeConfirmed(binding: WorkerConversationBinding) {
    return this.change(binding, record => { record.closed = true; return record })
  }
}
