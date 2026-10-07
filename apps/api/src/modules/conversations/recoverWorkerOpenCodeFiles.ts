import { readdir, rmdir, type FileHandle } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { MAX_FILE_BYTES } from '@foreman-code/contracts/files'
import { WorkerOpenCodeFilePreparationSchema, type WorkerConversationConfiguration,
  type WorkerConversationReceipt, type WorkerConversationRpcRequest,
  type WorkerOpenCodeFileRoot } from '@foreman-code/contracts/remote-execution-rpc'
import { DomainError } from '../errors.js'
import { anchored, openChildDirectory } from '../sources/privateFilesystem.js'
import { removeDirectoryContents } from '../harnesses/opencodeFiles/host.js'
import { recoverOpenCodeHandleVersions } from '../harnesses/opencodeFiles/recoverVersions.js'
import type { workerConversationCallbacks } from './workerCallbacks.js'
import { createWorkerOpenCodeFileService } from './workerOpenCodeFileService.js'

/** Used by journal cleanup only after the original native process is positively closed. */
export function workerOpenCodeVersionRecovery(input: {
  record: WorkerConversationReceipt
  request: WorkerConversationRpcRequest
  configuration: WorkerConversationConfiguration
  callbacks: Pick<ReturnType<typeof workerConversationCallbacks>, 'openCodeFiles'>
}) {
  return async (root: WorkerOpenCodeFileRoot, directory: FileHandle, signal: AbortSignal) => {
    const { record, request, configuration } = input
    const turn = record.turns.find(value => value.correlationId === root.correlationId)
    if ((request.method !== 'conversation.reconcile' && request.method !== 'conversation.recover-files') || !request.admissionId
      || request.correlationId !== root.correlationId || !turn?.nativeTurnId
      || root.nativeSessionId !== record.session?.nativeSessionId
      || request.session.nativeSessionId !== root.nativeSessionId || configuration.harness.harness !== 'opencode') {
      throw new DomainError('WORKER_FILE_VERSION_RECOVERY_REQUIRED',
        'Recover retained file versions through their original admitted message.', 409)
    }
    const owner = record.binding.owner
    const identity = { ownerAgentId: owner.kind === 'operator' ? owner.operatorId : owner.agentId,
      nativeSessionId: root.nativeSessionId, nativeTurnId: turn.nativeTurnId,
      clientCorrelationId: root.correlationId, directory: record.binding.workingDirectory,
      configuration: configuration.harness }
    const proxy = createWorkerOpenCodeFileService({ source: () => request, identity,
      callbacks: input.callbacks, signal, recovering: true })
    const prepared = WorkerOpenCodeFilePreparationSchema.parse(await proxy.call({ phase: 'prepare' }, signal))
    const service = { sessions: proxy.service.sessions, artifacts: proxy.service.artifacts,
      preserveAccepted: async (context: typeof prepared.context,
        version: Parameters<typeof proxy.preserveVersion>[0], preserveSignal: AbortSignal) => {
        if (!isDeepStrictEqual(context, prepared.context)) {
          throw new DomainError('OPENCODE_FILE_CONTEXT_DENIED', 'The retained version belongs to another message.', 403)
        }
        await proxy.preserveVersion(version, preserveSignal)
      } }
    for (const handle of await readdir(anchored(directory))) {
      signal.throwIfAborted()
      if (!/^[0-9a-f-]{36}$/.test(handle)) continue
      const child = await openChildDirectory(directory, handle)
      try {
        const names = await recoverOpenCodeHandleVersions(service, prepared.context, handle, child, MAX_FILE_BYTES, signal)
        if (names.length) await proxy.call({ phase: 'adopt', context: prepared.context }, signal)
        for (const name of names) {
          const versions = await openChildDirectory(child, name)
          try { await removeDirectoryContents(versions) } finally { await versions.close() }
          await rmdir(anchored(child, name))
          await child.sync()
        }
      } finally { await child.close() }
    }
  }
}
