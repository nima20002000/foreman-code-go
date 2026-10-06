import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { lstat, mkdir, mkdtemp, realpath, rmdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
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

const acknowledged = z.object({ acknowledged: z.literal(true) }).strict()
interface Delivery {
  source: WorkerConversationRpcRequest
  identity: OpenCodeChatFileIdentity
  prepared: z.infer<typeof WorkerOpenCodeFilePreparationSchema>
  turn?: OpenCodeManagedFileTurn
}

/** The installed native manager owns each listener and filesystem copy until settlement. */
export function createWorkerOpenCodeFiles(input: {
  stateDirectory: string
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
    let delivery: Delivery | undefined
    const proxy = createWorkerOpenCodeFileService({ ...input, source: () => delivery?.source ?? source, identity })
    const raw = await proxy.call({ phase: 'prepare' }, signal)
    if (raw === null) return undefined
    const prepared = WorkerOpenCodeFilePreparationSchema.parse(raw)
    delivery = { source, identity: structuredClone(identity), prepared }
    const parent = join(input.stateDirectory, 'opencode-chat-files')
    await mkdir(parent, { recursive: true, mode: 0o700 })
    const stat = await lstat(parent)
    checkFileCondition(stat.isDirectory() && !stat.isSymbolicLink() && !(stat.mode & 0o077)
      && stat.uid === process.getuid?.() && await realpath(parent) === resolve(parent),
    'FILE_HOST_INVALID', 'The native file directory must be private and canonical.')
    const root = await mkdtemp(join(parent, 'turn-'))
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
      await rmdir(root)
      closed = true
      cleanups.delete(cleanup)
      deliveries.delete(key(identity))
    }
    cleanups.add(cleanup)
    try {
      const endpoint = `${await listener.listen()}/mcp/files`
      const host = new LocalOpenCodeExecutionFiles({ root, executionHostId: `worker:${randomUUID()}`,
        maxFileBytes: MAX_FILE_BYTES,
        assertSourceIsolation: async checkSignal => {
          await input.assertCurrent(delivery!.source, checkSignal)
          await input.assertSourceIsolation(input.server.nativePid ?? 0, delivery!.prepared.sourceHost, checkSignal)
        } })
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
  }
}
