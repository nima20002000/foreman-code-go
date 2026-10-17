import { assertWorkerProviderAccountBinding } from '../provider-accounts/workerOperations.js'
import { isDeepStrictEqual } from 'node:util'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { WorkerConversationConfiguration, WorkerConversationReceipt,
  WorkerConversationRpcRequest } from '@foreman-code/contracts/remote-execution-rpc'
import type { CompactionState, ExecutionResult } from '@foreman-code/contracts'
import type { NativeProcessRegistry } from '../harnesses/recovery/processRegistry.js'
import type { WorkerConversationAllocation } from './workerHost.js'
import type { WorkerConversationJournal } from './workerJournal.js'
import { workerConversationProcessDigest } from './workerNativeOwner.js'
import { DomainError } from '../errors.js'
import { sameConversationForAppAccess } from './conversationAppAccess.js'
import { validRunChatSkillsTransition } from './workerRunChatBinding.js'

function unavailable(message: string): never {
  throw new DomainError('WORKER_CONVERSATION_RECOVERY_REQUIRED', message, 409)
}

/** Reopens the persisted session after positive process closure, without sending a model input. */
export async function recoverWorkerConversation(input: {
  record: WorkerConversationReceipt
  configuration: WorkerConversationConfiguration
  connection: Readonly<DeviceSessionBinding>
  request: WorkerConversationRpcRequest
  registry: Pick<NativeProcessRegistry, 'snapshot' | 'closeOwner'>
  journal: WorkerConversationJournal
  allocate(): Promise<WorkerConversationAllocation>
  assertCurrent(): Promise<void>
  signal: AbortSignal
}): Promise<WorkerConversationAllocation> {
  const { record, signal } = input
  signal.throwIfAborted()
  const session = record.session
  const owner = record.nativeOwner
  const request = input.request
  const changingAccess = request.method === 'conversation.open' && request.previousBinding
    && isDeepStrictEqual(request.previousBinding, record.binding)
    && sameConversationForAppAccess(record.binding, request.binding)
    && record.applicationAccessChange?.state === 'reserved'
    && record.applicationAccessChange.operationId === request.operationId
    && record.applicationAccessChange.next === request.binding.appMcpAccess
  const changingSkills = request.method === 'conversation.open' && request.mode === 'attach'
    && request.previousBinding && request.previousConfiguration
    && isDeepStrictEqual(request.previousBinding, record.binding)
    && isDeepStrictEqual(request.source, session)
    && validRunChatSkillsTransition(record.binding, request.binding, request.previousConfiguration, input.configuration)
  const targetBinding = changingAccess || changingSkills ? request.binding : record.binding
  if (!session || !owner || !record.creation || record.closing || record.closed) {
    unavailable('The persisted chat has no recoverable native session.')
  }
  if (commandInputHash(input.configuration) !== targetBinding.owner.configurationHash
    || input.configuration.harness.harness !== session.harness || owner.sessionId !== session.nativeSessionId
    || !isDeepStrictEqual(request.binding, record.binding) && !changingAccess && !changingSkills) {
    unavailable('The saved conversation configuration or native session changed.')
  }
  for (const field of ['mainId', 'deviceId', 'workerInstallationId', 'keyRevision', 'authorizationRevision'] as const) {
    if (record.connection[field] !== input.connection[field]) unavailable('The original paired worker authority changed.')
  }
  assertWorkerProviderAccountBinding(record.binding.accountBinding, input.connection)
  const scopeOwner = `conversation:${record.binding.owner.conversationId}`
  const snapshot = input.registry.snapshot()
  const launches = snapshot.launches.filter(launch => launch.owner === scopeOwner)
  const original = launches.filter(launch => launch.guardian && launch.provider && launch.boundary
    && workerConversationProcessDigest(record.binding, launch) === owner.processIdentityDigest)
  if (original.length !== 1 || !launches.length
    || launches.some(launch => launch.lifecycle !== 'closed' || !launch.closureEvidence)) {
    unavailable('The original native process has not been positively closed.')
  }
  await input.assertCurrent()
  if (record.turns.some(turn => !['completed', 'rejected'].includes(turn.status) && !turn.nativeTurnId && !turn.nativeSubmission)
    || record.compactions.some(control => !['completed', 'failed', 'no-op'].includes(control.state.status)
      && control.state.dispatchPhase !== 'dispatched')) {
    unavailable('The outstanding native input has no persisted dispatch identity; it will not be replayed.')
  }
  if (!await input.registry.closeOwner(scopeOwner, signal)) {
    unavailable('The original native chat process is still closing.')
  }
  const allocation = await input.allocate()
  try {
    const requestedPreferences = 'preferences' in input.request ? input.request.preferences : undefined
    const preferences = requestedPreferences ?? record.desiredPreferences
    if (preferences) await allocation.manager.configureSessionPreferences?.(preferences)
    const access = 'applicationAccess' in input.request ? input.request.applicationAccess : undefined
    const start = await allocation.start({ correlationId: record.creation.operationId, instructionsDelivered: true,
      ...(access ? { applicationAccess: access } : {}) })
    const attached = await allocation.manager.attachSession(session, start, signal)
    if (!isDeepStrictEqual(attached, session)) unavailable('Native recovery returned another session.')
    const recoveredTurns: Array<{ correlationId: string; result: ExecutionResult }> = []
    for (const turn of record.turns) {
      if (turn.status === 'rejected') continue
      const history = await allocation.manager.reconcile(session, turn.correlationId, signal)
      let terminal = history.correlationId === turn.correlationId ? history.terminalResult : undefined
      if (history.terminalTurn?.correlationId === turn.correlationId) terminal = history.terminalTurn.result
      // Claude transcripts retain the input receipt, while the completed result lives in the journal.
      if (!terminal && session.harness === 'claude' && turn.status === 'completed'
        && history.correlationId === turn.correlationId && turn.nativeSubmission
        && isDeepStrictEqual(history.nativeSubmission, turn.nativeSubmission)) {
        terminal = turn.result ?? undefined
      }
      const nativeId = history.nativeTurnId ?? history.nativeSubmission?.nativeMessageId
      const acceptedId = turn.nativeTurnId ?? turn.nativeSubmission?.nativeMessageId
      if (!terminal || !acceptedId || nativeId !== acceptedId
        || turn.status === 'completed' && (!turn.result || !isDeepStrictEqual(terminal, turn.result))
        || turn.result && !isDeepStrictEqual(terminal, turn.result)
        || turn.nativeSubmission && !isDeepStrictEqual(history.nativeSubmission, turn.nativeSubmission)
        || history.pendingInteraction || history.pendingInteractions?.length) {
        unavailable('The recorded native turn could not be recovered on its original session.')
      }
      if (turn.status !== 'completed') recoveredTurns.push({ correlationId: turn.correlationId, result: terminal })
    }
    const recoveredCompactions: CompactionState[] = []
    for (const control of record.compactions) {
      if (['completed', 'failed', 'no-op'].includes(control.state.status)) continue
      if (!allocation.manager.readCompaction) unavailable('This native driver cannot read a cold compaction result.')
      const state = await allocation.manager.readCompaction(session, start, control.state, signal)
      if (state.requestId !== control.state.requestId || state.nativeSessionId !== session.nativeSessionId
        || control.state.nativeOperationId && state.nativeOperationId !== control.state.nativeOperationId
        || !['completed', 'failed', 'no-op'].includes(state.status)) {
        unavailable('The dispatched native compaction has no confirmed result on its original session.')
      }
      recoveredCompactions.push(state)
    }
    signal.throwIfAborted()
    await input.assertCurrent()
    for (const turn of recoveredTurns) await input.journal.finishTurn(record.binding, turn.correlationId, turn.result)
    for (const state of recoveredCompactions) await input.journal.compactProgress(record.binding, state)
    await input.journal.recoveredOwner(record.binding, input.connection, owner, await allocation.nativeOwner(session),
      changingAccess || changingSkills ? { targetBinding,
        ...(changingSkills && request.method === 'conversation.open' && request.previousConfiguration
          ? { previousConfiguration: request.previousConfiguration, configuration: input.configuration } : {}) } : undefined)
    if (preferences) await input.journal.preferences(targetBinding, preferences,
      allocation.manager.appliedSessionPreferences?.(session) ?? null)
    return allocation
  } catch (error) {
    try { await allocation.close() }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Native recovery and cleanup failed.', { cause: cleanup }) }
    throw error
  }
}
