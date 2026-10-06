import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import {
  AgentFileApplyFormatEditResultSchema, AgentFileCreateWorkingCopyResultSchema, AgentFileListResultSchema,
  AgentFilePublishResultSchema, AgentFileReadResultSchema, AgentFileWriteWorkingCopyResultSchema,
  MAX_FILE_BYTES, MessageAttachmentRefsSchema, type FileRevision,
} from '@foreman-code/contracts/files'
import {
  WorkerOpenCodeArtifactSchema, WorkerOpenCodeFileCallerSchema, WorkerOpenCodeArtifactRangeSchema,
  type WorkerConversationRpcRequest, type WorkerOpenCodeFileAction, type WorkerOpenCodeFileIdentity,
} from '@foreman-code/contracts/remote-execution-rpc'
import type { OpenCodeFileService } from '../harnesses/opencodeFiles/types.js'
import type { FileToolContext } from '../files/tools/types.js'
import { collectCodexFileBytes } from '../harnesses/codexFiles/bytes.js'
import type { workerConversationCallbacks } from './workerCallbacks.js'
import { DomainError } from '../errors.js'

const acknowledged = z.object({ acknowledged: z.literal(true) }).strict()

export function createWorkerOpenCodeFileService(input: {
  source(): WorkerConversationRpcRequest
  identity: WorkerOpenCodeFileIdentity
  callbacks: Pick<ReturnType<typeof workerConversationCallbacks>, 'openCodeFiles'>
  signal: AbortSignal
}) {
  let issuedToken: string | undefined
  const call = (action: WorkerOpenCodeFileAction, signal = input.signal) =>
    input.callbacks.openCodeFiles(input.source(), input.identity, action, signal)
  const token = () => {
    if (!issuedToken) throw new DomainError('OPENCODE_FILE_CONTEXT_DENIED', 'The native file tools are not acknowledged.', 403)
    return issuedToken
  }
  const assertContext = (context: Pick<FileToolContext, 'nativeSessionId' | 'turnId'>) => {
    if (context.nativeSessionId !== input.identity.nativeSessionId || context.turnId !== input.identity.nativeTurnId) {
      throw new DomainError('OPENCODE_FILE_CONTEXT_DENIED', 'The artifact caller belongs to another native turn.', 403)
    }
  }
  const service: OpenCodeFileService = {
    sessions: {
      async issueForAcceptedSession(context, expiresAt) {
        const result = z.object({ token: z.string() }).strict().parse(await call({ phase: 'issue',
          context: { ...context, turnId: context.turnId!, messageId: context.messageId! },
          expiresAt: expiresAt.toISOString() }))
        issuedToken = result.token
        return result.token
      },
      authenticate: async (credential, tool) => WorkerOpenCodeFileCallerSchema.parse(await call({
        phase: 'authenticate', ...(credential !== undefined ? { token: credential } : {}),
        ...(tool !== undefined ? { tool } : {}),
      })),
      authorizeAccepted: async (context, tool) => {
        assertContext(context)
        return WorkerOpenCodeFileCallerSchema.parse(await call({ phase: 'authorize-accepted',
          ...(tool !== undefined ? { tool } : {}) }))
      },
      async revoke(credential) { acknowledged.parse(await call({ phase: 'revoke', token: credential })) },
    },
    list: async (credential, args) => AgentFileListResultSchema.parse(await call({
      phase: 'service', token: credential, operation: 'list', input: args,
    })),
    read: async (credential, args) => AgentFileReadResultSchema.parse(await call({
      phase: 'service', token: credential, operation: 'read', input: args,
    })),
    createWorkingCopy: async (credential, args) => AgentFileCreateWorkingCopyResultSchema.parse(await call({
      phase: 'service', token: credential, operation: 'createWorkingCopy', input: args,
    })),
    writeWorkingCopy: async (credential, args) => AgentFileWriteWorkingCopyResultSchema.parse(await call({
      phase: 'service', token: credential, operation: 'writeWorkingCopy', input: args,
    })),
    applyFormatEdit: async (credential, args) => AgentFileApplyFormatEditResultSchema.parse(await call({
      phase: 'service', token: credential, operation: 'applyFormatEdit', input: args,
    })),
    publish: async (credential, args) => AgentFilePublishResultSchema.parse(await call({
      phase: 'service', token: credential, operation: 'publish', input: args,
    })),
    publishedForTurn: async credential => MessageAttachmentRefsSchema.parse(await call({
      phase: 'service', token: credential, operation: 'publishedForTurn',
    })),
    artifacts: {
      get: async (caller, artifactId) => {
        assertContext(caller.context)
        const artifact = WorkerOpenCodeArtifactSchema.parse(await call({ phase: 'artifact-get', token: token(), artifactId }))
        const { source, sourceSha256, snapshot, storageKeys, retiredAt, ...required } = artifact
        return { ...required,
          ...(source !== undefined ? { source } : {}),
          ...(sourceSha256 !== undefined ? { sourceSha256 } : {}),
          ...(snapshot !== undefined ? { snapshot } : {}),
          ...(storageKeys !== undefined ? { storageKeys } : {}),
          ...(retiredAt !== undefined ? { retiredAt } : {}),
        }
      },
      readSnapshot: async (caller, artifactId, signal) => {
        assertContext(caller.context)
        const chunks: Buffer[] = []
        let revision: FileRevision | undefined
        let offset = 0
        while (true) {
          signal.throwIfAborted()
          const range = WorkerOpenCodeArtifactRangeSchema.parse(await call({ phase: 'artifact-read',
            token: token(), artifactId, offset, length: 65536 }, signal))
          const bytes = Buffer.from(range.contentBase64, 'base64')
          revision ??= range.revision
          if (range.offset !== offset || !isDeepStrictEqual(range.revision, revision)
            || bytes.toString('base64') !== range.contentBase64 || bytes.length > 65536
            || offset + bytes.length > MAX_FILE_BYTES || !bytes.length && !range.eof) {
            throw new DomainError('FILE_ARTIFACT_CHANGED', 'The artifact changed during transfer.', 409)
          }
          chunks.push(bytes)
          offset += bytes.length
          if (range.eof) break
        }
        const bytes = Buffer.concat(chunks)
        if (bytes.length !== revision.byteSize || createHash('sha256').update(bytes).digest('hex') !== revision.sha256) {
          throw new DomainError('FILE_ARTIFACT_CHANGED', 'The artifact snapshot does not match its revision.', 409)
        }
        return { revision, bytes }
      },
      async beginWrite(credential, artifactId, baseRevisionId) {
        const result = z.object({ writeId: z.uuid() }).strict().parse(await call({ phase: 'artifact-begin',
          token: credential, artifactId, ...(baseRevisionId !== undefined ? { baseRevisionId } : {}),
        }))
        return result.writeId
      },
      async abortWrite(credential, artifactId, writeId) {
        acknowledged.parse(await call({ phase: 'artifact-abort', token: credential, artifactId, writeId }))
      },
      async completeWrite(credential, artifactId, writeId, source, signal = input.signal) {
        const bytes = await collectCodexFileBytes(source, MAX_FILE_BYTES, signal)
        const transfer = { token: credential, artifactId, writeId, transferId: randomUUID() }
        acknowledged.parse(await call({ phase: 'write-begin', ...transfer }, signal))
        for (let offset = 0; offset < bytes.length; offset += 65536) {
          acknowledged.parse(await call({ phase: 'write-chunk', ...transfer, offset,
            contentBase64: bytes.subarray(offset, offset + 65536).toString('base64') }, signal))
        }
        acknowledged.parse(await call({ phase: 'write-finish', ...transfer }, signal))
      },
    },
  }
  const preserveVersion = async (version: { id: string; revision: FileRevision; bytes: Uint8Array }, signal: AbortSignal) => {
    if (version.bytes.byteLength > MAX_FILE_BYTES) {
      throw new DomainError('FILE_ARTIFACT_TOO_LARGE', 'The retained version exceeds the file limit.', 409)
    }
    const transferId = randomUUID()
    acknowledged.parse(await call({ phase: 'preserve-begin', transferId, id: version.id, revision: version.revision }, signal))
    for (let offset = 0; offset < version.bytes.byteLength; offset += 65536) {
      acknowledged.parse(await call({ phase: 'preserve-chunk', transferId, offset,
        contentBase64: Buffer.from(version.bytes.subarray(offset, offset + 65536)).toString('base64') }, signal))
    }
    acknowledged.parse(await call({ phase: 'preserve-finish', transferId }, signal))
  }
  return { service, call, preserveVersion }
}
