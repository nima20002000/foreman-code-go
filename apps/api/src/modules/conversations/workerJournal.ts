import { isDeepStrictEqual } from 'node:util'
import type { CompactionState, ExecutionResult, NativeSessionReference, SessionPreferences, SessionMode } from '@foreman-code/contracts'
import type { NativeMessageSubmission } from '@foreman-code/contracts/claude'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { RemoteNativeIdentity } from '@foreman-code/contracts/remote-execution'
import type { WorkerConversationBinding, WorkerConversationReceipt } from '@foreman-code/contracts/remote-execution-rpc'
import { DomainError } from '../errors.js'
import { sameConversationForAppAccess } from './conversationAppAccess.js'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { WorkerClaudeCallbackRecordSchema } from '@foreman-code/contracts/remote-execution-rpc'
import type { ClaudeCallbackJournal } from '../harnesses/claudeSdk/callbackJournal.js'
import { definedProperties } from '../definedProperties.js'

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
  if (record.applicationAccessChange?.state === 'reserved') conflict('The native App MCP access change needs recovery.')
}
function unsettled(record: WorkerConversationReceipt) {
  return record.turns.some(turn => !['completed', 'rejected'].includes(turn.status))
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

  async inspectBinding(binding: WorkerConversationBinding) {
    const record = (await this.store.read()).find(value => value.binding.owner.conversationId === binding.owner.conversationId)
    if (record && !isDeepStrictEqual(record.binding, binding)
      && !sameConversationForAppAccess(record.binding, binding)) conflict('The original conversation binding changed.')
    return record
  }

  claudeCallbackJournal(binding: WorkerConversationBinding): ClaudeCallbackJournal {
    const records = async () => Object.values((await this.inspectBinding(binding))?.claudeCallbacks ?? {})
      .map(record => definedProperties({ ...record, identity: definedProperties(record.identity) }))
    return {
      read: async key => (await records()).find(record => commandInputHash(record.identity) === key),
      write: async (key, value) => {
        const callback = WorkerClaudeCallbackRecordSchema.parse(value)
        if (key !== commandInputHash(callback.identity)) conflict('The callback journal key differs from its native identity.')
        await this.change(binding, record => {
          if (binding.harness !== 'claude' || callback.identity.nativeSessionId !== record.session?.nativeSessionId) {
            conflict('The callback belongs to another native session.')
          }
          const callbacks = record.claudeCallbacks ??= {}
          const previous = callbacks[key]
          if (previous && (!isDeepStrictEqual(previous.identity, callback.identity)
            || previous.inputHash !== callback.inputHash || previous.toolName !== callback.toolName
            || previous.state !== callback.state || previous.selectedOptionId !== callback.selectedOptionId)) {
            conflict('The consumed callback has different input or response.')
          }
          callbacks[key] = { ...callback, acknowledged: previous?.acknowledged === true || callback.acknowledged,
            ...(previous?.retired || callback.retired ? { retired: true } : {}) }
        })
      },
      forTool: async identity => {
        const matching = (await records()).filter(record => record.identity.nativeSessionId === identity.nativeSessionId
          && record.identity.nativeMessageId === identity.nativeMessageId && record.identity.generation === identity.generation
          && record.identity.toolUseId === identity.toolUseId)
        return matching.length === 1 ? matching[0] : undefined
      },
      acknowledged: async sessionId => (await records()).filter(record =>
        record.identity.nativeSessionId === sessionId && record.acknowledged && !record.retired),
    }
  }

  reserveApplicationAccess(previous: WorkerConversationBinding, next: WorkerConversationBinding, operationId: string,
    session: NativeSessionReference) {
    const inputHash = commandInputHash({ previous, next })
    return this.store.change(records => {
      const record = records.find(value => value.binding.owner.conversationId === previous.owner.conversationId)
      if (!record || !sameConversationForAppAccess(previous, next) || previous.appMcpAccess === next.appMcpAccess
        || record.closed || record.closing || !isDeepStrictEqual(record.session, session) || !record.nativeOwner || unsettled(record)) {
        conflict('Only a settled Operator session can change its App MCP access.')
      }
      const change = record.applicationAccessChange
      if (change?.operationId === operationId) {
        if (change.inputHash !== inputHash || !isDeepStrictEqual(record.binding, change.state === 'applied' ? next : previous)) {
          conflict('The original App MCP access change has different input.')
        }
        return { applied: change.state === 'applied', reserved: false, record }
      }
      if (change?.state === 'reserved' || !isDeepStrictEqual(record.binding, previous)) {
        conflict('The original App MCP access change needs recovery.')
      }
      record.applicationAccessChange = { operationId, inputHash, previous: previous.appMcpAccess,
        next: next.appMcpAccess, state: 'reserved' }
      record.revision++
      return { applied: false, reserved: true, record }
    })
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
      if (record.creation && (record.creation.status !== 'rejected' || record.creation.operationId === operationId)) {
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

  reserveInitialTurn(binding: WorkerConversationBinding, operationId: string, creationHash: string,
    correlationId: string, inputHash: string, mode: SessionMode) {
    return this.change(binding, record => {
      writable(record)
      const original = record.turns.find(turn => turn.correlationId === correlationId)
      if (original) {
        if (original.inputHash !== inputHash || original.sessionMode !== mode
          || original.creationOperationId && original.creationOperationId !== operationId) {
          conflict('The original initial turn input changed.')
        }
        return { dispatch: false, record }
      }
      const creationPending = record.creation && record.creation.status !== 'rejected'
      if (creationPending || record.session || unsettled(record)) {
        conflict('Native creation has already been reserved for another request.')
      }
      if (record.turns.length >= 1000) conflict('The conversation turn journal is full.')
      record.creation = { operationId, inputHash: creationHash }
      record.turns.push({ correlationId, inputHash, status: 'reserved', nativeTurnId: null,
        sessionMode: mode, creationOperationId: operationId })
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

  recoveredOwner(binding: WorkerConversationBinding, connection: DeviceSessionBinding,
    previous: RemoteNativeIdentity, next: RemoteNativeIdentity,
    options?: { targetBinding?: WorkerConversationBinding; pendingCorrelationId?: string }) {
    return this.change(binding, record => {
      if (record.closed || record.closing) conflict('The native conversation is closing or closed.')
      const change = record.applicationAccessChange
      const targetBinding = options?.targetBinding
      if (targetBinding) {
        if (!change || change.state !== 'reserved' || change.previous !== binding.appMcpAccess
          || change.next !== targetBinding.appMcpAccess || !sameConversationForAppAccess(binding, targetBinding)) {
          conflict('The original App MCP access change was not reserved.')
        }
      } else if (change?.state === 'reserved') conflict('The native App MCP access change needs recovery.')
      const pending = record.turns.find(turn => turn.correlationId === options?.pendingCorrelationId)
      const replacingBeforeInput = pending?.status === 'reserved' && !pending.nativeTurnId && !pending.nativeSubmission
      const otherPending = record.turns.some(turn => !['completed', 'rejected'].includes(turn.status)
        && (!replacingBeforeInput || turn !== pending))
        || record.compactions.some(control => ['accepted', 'running', 'uncertain'].includes(control.state.status))
      if (otherPending || !record.session || !isDeepStrictEqual(record.nativeOwner, previous)
        || previous.sessionId !== record.session.nativeSessionId || next.sessionId !== previous.sessionId) {
        conflict('The recovered process does not own the settled conversation session.')
      }
      for (const field of ['mainId', 'deviceId', 'workerInstallationId', 'keyRevision', 'authorizationRevision'] as const) {
        if (record.connection[field] !== connection[field]) conflict('The original paired worker authority changed.')
      }
      const transitions = record.ownerTransitions ??= []
      if (transitions.length >= 1000) conflict('The conversation owner journal is full.')
      transitions.push({ previous, next })
      record.nativeOwner = next
      record.connection = connection
      if (targetBinding) {
        record.binding = structuredClone(targetBinding)
        change!.state = 'applied'
      }
      return record
    })
  }

  reserveTurn(binding: WorkerConversationBinding, correlationId: string, inputHash: string,
    options?: { mode: SessionMode }) {
    return this.change(binding, record => {
      writable(record)
      const original = record.turns.find(turn => turn.correlationId === correlationId)
      if (original) {
        if (original.inputHash !== inputHash || original.sessionMode !== undefined
          && original.sessionMode !== (options?.mode ?? 'regular')) conflict('The original turn input changed.')
        return { dispatch: false, record }
      }
      if (unsettled(record)) conflict('Recover the pending native operation before sending another turn.')
      if (record.turns.length >= 1000) conflict('The conversation turn journal is full.')
      record.turns.push({ correlationId, inputHash, status: 'reserved', nativeTurnId: null,
        sessionMode: options?.mode ?? 'regular' })
      return { dispatch: true, record }
    })
  }

  submitted(binding: WorkerConversationBinding, correlationId: string,
    identity: { nativeTurnId?: string; nativeSubmission?: NativeMessageSubmission }) {
    return this.change(binding, record => {
      const turn = record.turns.find(value => value.correlationId === correlationId)
      if (!turn || !record.session) conflict('The native input has no conversation reservation.')
      if (turn.status === 'rejected') conflict('The rejected native input cannot be submitted.')
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
      if (!['completed', 'rejected'].includes(turn.status)) turn.status = 'submitted'
      return record
    })
  }

  rejectTurn(binding: WorkerConversationBinding, correlationId: string, result: ExecutionResult,
    creationOperationId?: string) {
    return this.change(binding, record => {
      const turn = record.turns.find(value => value.correlationId === correlationId)
      if (!turn || result.outcome !== 'failed') conflict('The rejected input has no failed turn reservation.')
      if (turn.status === 'completed' || turn.status === 'rejected') return record
      if (turn.nativeTurnId || turn.nativeSubmission || turn.status !== 'reserved') {
        turn.status = 'uncertain'
        return record
      }
      if (creationOperationId && !record.session) {
        if (record.creation?.operationId !== creationOperationId) conflict('The rejected creation request changed.')
        record.creation.status = 'rejected'
      }
      turn.status = 'rejected'
      turn.result = result
      return record
    })
  }

  finishTurn(binding: WorkerConversationBinding, correlationId: string, result?: ExecutionResult) {
    return this.change(binding, record => {
      const turn = record.turns.find(value => value.correlationId === correlationId)
      if (!turn) conflict('The native turn has no conversation reservation.')
      if (turn.status === 'rejected') return record
      if (turn.result && result && !isDeepStrictEqual(turn.result, result)) conflict('The native turn result changed.')
      if (result) {
        turn.result = result
        turn.status = 'completed'
      } else if (!['completed', 'rejected'].includes(turn.status)) turn.status = 'uncertain'
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
      control.state = { ...state, dispatchPhase: state.dispatchPhase ?? control.state.dispatchPhase }
      return control.state
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
