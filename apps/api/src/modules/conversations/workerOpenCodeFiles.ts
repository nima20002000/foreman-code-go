import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { AgentFileReadResultSchema, MAX_FILE_BYTES, MAX_MESSAGE_ATTACHMENTS } from '@foreman-code/contracts/files'
import { WorkerOpenCodeFilePreparationSchema, type WorkerConversationRpcRequest } from '@foreman-code/contracts/remote-execution-rpc'
import type { FileMcpService } from '../files/tools/mcpServer.js'
import { createNativeFileMcpServer } from '../files/tools/nativeServer.js'
import type { OpenCodeChatFiles, OpenCodeChatFileIdentity, OpenCodeManagedFileTurn } from '../harnesses/opencodeFiles/chat.js'
import { LocalOpenCodeExecutionFiles } from '../harnesses/opencodeFiles/host.js'
import { checkFileCondition } from '../harnesses/opencodeFiles/types.js'
import type { OpenCodeServerController } from '../harnesses/opencodeTransport.js'
import type { workerConversationCallbacks } from './workerCallbacks.js'
import { createWorkerOpenCodeFileService } from './workerOpenCodeFileService.js'
import type { assertWorkerOpenCodeFileHost } from './workerOpenCodeFileHost.js'
import type { WorkerOpenCodeDirectories } from './workerOpenCodeDirectories.js'

const acknowledged = z.object({ acknowledged: z.literal(true) }).strict()
interface Delivery {
  source: WorkerConversationRpcRequest
  identity: OpenCodeChatFileIdentity
  prepared: z.infer<typeof WorkerOpenCodeFilePreparationSchema>
  turn?: OpenCodeManagedFileTurn
  host?: LocalOpenCodeExecutionFiles
}

/** The installed native manager owns each listener and filesystem copy until settlement. */
export function createWorkerOpenCodeFiles(input: {
  directories: Pick<WorkerOpenCodeDirectories, 'create' | 'release'>
  source(): WorkerConversationRpcRequest
  callbacks: Pick<ReturnType<typeof workerConversationCallbacks>, 'openCodeFiles'>
  server: OpenCodeServerController
  assertCurrent(source: WorkerConversationRpcRequest, signal: AbortSignal): Promise<void>
  assertSourceIsolation: typeof assertWorkerOpenCodeFileHost
  signal: AbortSignal
}) {
  const cleanups = new Set<() => Promise<void>>()
  const deliveries = new Map<string, Delivery>()
  const key = (identity: OpenCodeChatFileIdentity) => JSON.stringify([identity.nativeSessionId, identity.nativeTurnId])
  const adapter: OpenCodeChatFiles = { async resolve(identity, signal) {
    const source = input.source()
    await input.assertCurrent(source, signal)
    checkFileCondition(!deliveries.has(key(identity)), 'FILE_TURN_CONFLICT', 'The native file turn is already retained.')
    const raw = await input.callbacks.openCodeFiles(source, identity, { phase: 'prepare' }, signal)
    if (raw === null) return undefined
    const prepared = WorkerOpenCodeFilePreparationSchema.parse(raw)
    const delivery: Delivery = { source, identity: structuredClone(identity), prepared }
    const proxy = createWorkerOpenCodeFileService({ ...input, source: () => delivery.source, identity })
    const root = await input.directories.create(source.binding, identity.clientCorrelationId, identity.nativeSessionId)
    let facade: FileMcpService | undefined
    const listener = createNativeFileMcpServer(() => {
      checkFileCondition(facade, 'FILE_TURN_CLOSED', 'The native file listener is not mounted.')
      return facade
    }, () => { /* File operations are audited by the Main file service. */ })
    let closed = false
    const cleanup = async () => {
      if (closed) return
      facade = undefined
      await listener.close()
      await input.directories.release(source.binding, root.record, {
        closedProcess: false, signal: AbortSignal.timeout(10000),
      })
      closed = true
      cleanups.delete(cleanup)
      deliveries.delete(key(identity))
    }
    cleanups.add(cleanup)
    try {
      const endpoint = `${await listener.listen()}/mcp/files`
      const host = new LocalOpenCodeExecutionFiles({ root: root.path, executionHostId: `worker:${randomUUID()}`,
        maxFileBytes: MAX_FILE_BYTES,
        assertSourceIsolation: async checkSignal => {
          await input.assertCurrent(delivery.source, checkSignal)
          await input.assertSourceIsolation(input.server.nativePid ?? 0, delivery.prepared.sourceHost, checkSignal)
        } })
      delivery.host = host
      deliveries.set(key(identity), delivery)
      return {
        admission: { context: prepared.context, attachments: prepared.attachments,
          expiresAt: new Date(prepared.expiresAt), executionHostId: host.executionHostId,
          directory: identity.directory, mode: prepared.context.allowMutation ? 'write' : 'read' },
        options: { service: proxy.service, host, endpoint,
          maxFileBytes: MAX_FILE_BYTES, maxAttachments: MAX_MESSAGE_ATTACHMENTS },
        read: async (range, readSignal) => AgentFileReadResultSchema.parse(
          await proxy.call({ phase: 'read-input', input: range }, readSignal)),
        adoptPublished: async context => {
          acknowledged.parse(await proxy.call({ phase: 'adopt', context: {
            ...context, turnId: context.turnId!, messageId: context.messageId!,
          } }))
        },
        mount: async service => {
          checkFileCondition(!facade && !closed, 'FILE_TURN_CLOSED', 'The native file listener is already mounted or closed.')
          facade = service
          return cleanup
        },
      }
    } catch (error) {
      try { await cleanup() }
      catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Native file listener cleanup failed.', { cause: cleanupError })
      }
      throw error
    }
  }, retain(identity, turn) {
    const delivery = deliveries.get(key(identity))
    checkFileCondition(delivery && !delivery.turn && isDeepStrictEqual(delivery.identity, identity),
      'FILE_TURN_CONFLICT', 'Retain only the prepared native file identity.')
    delivery.turn = turn
  } }
  return { adapter,
    async recover(request: Extract<WorkerConversationRpcRequest, { method: 'conversation.history' | 'conversation.reconcile' }>,
      nativeTurnId: string, signal: AbortSignal) {
      const found = [...deliveries.values()].filter(value => value.identity.nativeSessionId === request.session.nativeSessionId
        && value.identity.nativeTurnId === nativeTurnId && value.identity.clientCorrelationId === request.correlationId
        && isDeepStrictEqual(value.source.binding, request.binding))
      if (!found.length) return
      checkFileCondition(found.length === 1 && request.method === 'conversation.reconcile' && request.admissionId,
        'FILE_CONTEXT_DENIED', 'Recover the original file turn through an admitted reconciliation.')
      const delivery = found[0]!
      if (delivery.source.admissionId === request.admissionId) return
      checkFileCondition(delivery.turn, 'FILE_TURN_CONFLICT', 'The native file input has not been retained.')
      await input.assertCurrent(request, signal)
      const call = (action: Parameters<typeof input.callbacks.openCodeFiles>[2]) =>
        input.callbacks.openCodeFiles(request, delivery.identity, action, signal)
      const prepared = WorkerOpenCodeFilePreparationSchema.parse(await call({ phase: 'prepare' }))
      checkFileCondition(isDeepStrictEqual(prepared.context, delivery.prepared.context)
        && isDeepStrictEqual(prepared.attachments, delivery.prepared.attachments),
      'FILE_CONTEXT_DENIED', 'Recovery cannot change the original file scope, pins or permissions.')
      await delivery.turn.bridge.refreshCredential(async () => {
        acknowledged.parse(await call({ phase: 'recover', context: prepared.context }))
        delivery.source = request
        delivery.prepared = prepared
        return new Date(prepared.expiresAt)
      }, signal)
    },
    async close() { await Promise.all([...cleanups].map(cleanup => cleanup())) },
    async releaseClosedHandles() {
      await Promise.all([...deliveries.values()].map(delivery => delivery.host?.close()))
    },
  }
}
