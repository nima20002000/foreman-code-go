import { isDeepStrictEqual } from 'node:util'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { WorkerConversationConfiguration, WorkerConversationReceipt,
  WorkerConversationRpcRequest } from '@foreman-code/contracts/remote-execution-rpc'
import type { NativeProcessRegistry } from '../harnesses/recovery/processRegistry.js'
import type { WorkerConversationAllocation } from './workerHost.js'
import type { WorkerConversationJournal } from './workerJournal.js'
import { workerConversationProcessDigest } from './workerNativeOwner.js'
import { DomainError } from '../errors.js'

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
  if (!session || !owner || !record.creation || record.closing || record.closed) {
    unavailable('The persisted chat has no recoverable native session.')
  }
  if (commandInputHash(input.configuration) !== record.binding.owner.configurationHash
    || input.configuration.harness.harness !== session.harness || owner.sessionId !== session.nativeSessionId
    || !isDeepStrictEqual(input.request.binding, record.binding)) {
    unavailable('The saved conversation configuration or native session changed.')
  }
  for (const field of ['mainId', 'deviceId', 'workerInstallationId', 'keyRevision', 'authorizationRevision'] as const) {
    if (record.connection[field] !== input.connection[field]) unavailable('The original paired worker authority changed.')
  }
  if (record.turns.some(turn => turn.status !== 'completed')
    || record.compactions.some(control => !['completed', 'failed', 'no-op'].includes(control.state.status))) {
    unavailable('Read the outstanding native result before reopening this chat; its input will not be replayed.')
  }
  const scopeOwner = `conversation:${record.binding.owner.conversationId}`
  const snapshot = input.registry.snapshot()
  const launches = snapshot.launches.filter(launch => launch.owner === scopeOwner)
  const original = launches.filter(launch => launch.guardian && launch.provider && launch.boundary
    && workerConversationProcessDigest(record.binding, launch) === owner.processIdentityDigest)
  if (original.length !== 1 || !launches.length
    || launches.some(launch => launch.lifecycle !== 'closed' || !launch.closureEvidence)) {
    unavailable('The original native process has not been positively closed.')
  }
  if (!await input.registry.closeOwner(scopeOwner, signal)) {
    unavailable('The original native chat process is still closing.')
  }
  await input.assertCurrent()
  const allocation = await input.allocate()
  try {
    const requestedPreferences = 'preferences' in input.request ? input.request.preferences : undefined
    const preferences = requestedPreferences ?? record.desiredPreferences
    if (preferences) await allocation.manager.configureSessionPreferences?.(preferences)
    const access = 'applicationAccess' in input.request ? input.request.applicationAccess : undefined
    if (access && allocation.deliverClaudeCredential) {
      await allocation.deliverClaudeCredential(access.token, signal)
    }
    const start = await allocation.start({ correlationId: record.creation.operationId, instructionsDelivered: true,
      ...(access ? { applicationAccess: access } : {}) })
    const attached = await allocation.manager.attachSession(session, start, signal)
    if (!isDeepStrictEqual(attached, session)) unavailable('Native recovery returned another session.')
    for (const turn of record.turns) {
      const history = await allocation.manager.reconcile(session, turn.correlationId, signal)
      let terminal = history.correlationId === turn.correlationId ? history.terminalResult : undefined
      if (history.terminalTurn?.correlationId === turn.correlationId) terminal = history.terminalTurn.result
      const nativeId = history.nativeTurnId ?? history.nativeSubmission?.nativeMessageId
      const acceptedId = turn.nativeTurnId ?? turn.nativeSubmission?.nativeMessageId
      if (!turn.result || !terminal || !isDeepStrictEqual(terminal, turn.result) || nativeId !== acceptedId
        || history.pendingInteraction || history.pendingInteractions?.length) {
        unavailable('The recorded native turn could not be recovered on its original session.')
      }
    }
    signal.throwIfAborted()
    await input.assertCurrent()
    await input.journal.recoveredOwner(record.binding, input.connection, owner, await allocation.nativeOwner(session))
    if (preferences) await input.journal.preferences(record.binding, preferences,
      allocation.manager.appliedSessionPreferences?.(session) ?? null)
    return allocation
  } catch (error) {
    try { await allocation.close() }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Native recovery and cleanup failed.', { cause: cleanup }) }
    throw error
  }
}
