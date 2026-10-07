import { isDeepStrictEqual } from 'node:util'
import { Readable } from 'node:stream'
import {
  AgentFileApplyFormatEditInputSchema, AgentFileCreateWorkingCopyInputSchema, AgentFileListInputSchema,
  AgentFilePublishInputSchema, AgentFileReadInputSchema, AgentFileWriteWorkingCopyInputSchema,
  MAX_FILE_BYTES, type MessageAttachmentRef,
} from '@foreman-code/contracts/files'
import type { WorkerOpenCodeFileAction, WorkerOpenCodeFileIdentity } from '@foreman-code/contracts/remote-execution-rpc'
import { WorkerOpenCodeFileContextSchema } from '@foreman-code/contracts/remote-execution-rpc'
import type { AgentFileToolService } from '../files/tools/service.js'
import type { FileToolContext } from '../files/tools/types.js'
import { isMutation } from '../files/tools/context.js'
import { DomainError } from '../errors.js'

export interface MainOpenCodeFilePorts {
  sourceHost(): { bootId: string; storageRoot: string }
  resolve(identity: WorkerOpenCodeFileIdentity): Promise<{
    context: FileToolContext; attachments: MessageAttachmentRef[];
  } | undefined>
  service(): AgentFileToolService
  adopt(context: FileToolContext): Promise<void>
}
interface WriteTransfer {
  identity: Extract<WorkerOpenCodeFileAction, { phase: 'write-begin' }>
  chunks: Buffer[]
  length: number
  completion?: Promise<void>
}
interface VersionTransfer {
  identity: Extract<WorkerOpenCodeFileAction, { phase: 'preserve-begin' }>
  chunks: Buffer[]
  length: number
  completion?: Promise<void>
}

/** Main owns file authority and immutable bytes; the native worker owns filesystem copies. */
export class MainWorkerOpenCodeFiles {
  private prepared: Promise<{ context: FileToolContext; attachments: MessageAttachmentRef[] } | undefined> | undefined
  private identity: WorkerOpenCodeFileIdentity | undefined
  private token: string | undefined
  private issuance: Promise<string> | undefined
  private revoked = false
  private recoveryVerified = false
  private readonly writes = new Map<string, WriteTransfer>()
  private readonly versions = new Map<string, VersionTransfer>()

  constructor(private readonly ports: MainOpenCodeFilePorts) {}

  private denied(): never {
    throw new DomainError('OPENCODE_FILE_CONTEXT_DENIED', 'The admitted native file turn is unavailable.', 403)
  }

  private async preparation(identity: WorkerOpenCodeFileIdentity, readOnly: boolean) {
    if (this.identity && !isDeepStrictEqual(this.identity, identity)) this.denied()
    this.identity ??= structuredClone(identity)
    this.prepared ??= this.ports.resolve(identity).then(value => {
      if (!value) return value
      const context = WorkerOpenCodeFileContextSchema.parse(value.context)
      if (context.nativeSessionId !== identity.nativeSessionId || context.turnId !== identity.nativeTurnId) this.denied()
      if (readOnly) {
        context.allowMutation = false
        context.allowedTools = context.allowedTools.filter(tool => !isMutation(tool))
      }
      return { context, attachments: structuredClone(value.attachments) }
    })
    return this.prepared
  }

  private async caller(token: string | undefined, context: FileToolContext) {
    if (!this.token || token !== this.token || this.revoked) this.denied()
    const caller = await this.ports.service().sessions.authenticate(token)
    if (!isDeepStrictEqual(caller.context, context)) this.denied()
    return caller
  }

  async handle(identity: WorkerOpenCodeFileIdentity, action: WorkerOpenCodeFileAction, input: {
    readOnly: boolean; acknowledgedTurnId?: string | undefined; signal: AbortSignal;
    recovering?: boolean;
  }): Promise<unknown> {
    input.signal.throwIfAborted()
    const prepared = await this.preparation(identity, input.readOnly)
    if (!prepared) {
      if (action.phase === 'prepare') return null
      this.denied()
    }
    const { context, attachments } = prepared
    const service = this.ports.service()
    if (action.phase === 'prepare') return { context, attachments,
      expiresAt: new Date(Date.now() + 3600000).toISOString(), sourceHost: this.ports.sourceHost() }
    if (action.phase === 'read-input') {
      if (!attachments.some(ref => ref.fileId === action.input.fileId && ref.revisionId === action.input.revisionId)) this.denied()
      return service.readAccepted(context, action.input)
    }
    if (action.phase === 'authorize-accepted') {
      return service.sessions.authorizeAccepted(context, action.tool)
    }
    if (action.phase === 'recover') {
      if (!input.recovering || input.acknowledgedTurnId !== context.turnId
        || !isDeepStrictEqual(context, action.context) || this.issuance || this.revoked) this.denied()
      await service.sessions.recoverAcceptedSession(context)
      this.recoveryVerified = true
      return { acknowledged: true }
    }
    if (action.phase === 'close') {
      await this.close()
      return { acknowledged: true }
    }
    if (action.phase === 'adopt') {
      if (!isDeepStrictEqual(context, action.context) || input.acknowledgedTurnId !== context.turnId) this.denied()
      await this.ports.adopt(context)
      return { acknowledged: true }
    }
    if (action.phase === 'revoke') {
      if (action.token !== this.token) this.denied()
      await service.sessions.revoke(action.token)
      this.revoked = true
      return { acknowledged: true }
    }
    if (input.acknowledgedTurnId !== context.turnId) this.denied()
    if (action.phase === 'recovery-artifact') {
      if (!input.recovering) this.denied()
      const caller = await service.sessions.authorizeAccepted(context, 'files.publish_result')
      return service.artifacts.get(caller, action.artifactId)
    }
    if (action.phase === 'preserve-begin' || action.phase === 'preserve-chunk' || action.phase === 'preserve-finish') {
      await service.sessions.authorizeAccepted(context, 'files.publish_result')
      return this.preserve(action, context, input.signal)
    }
    if (action.phase === 'issue') {
      if (!isDeepStrictEqual(context, action.context) || this.revoked
        || input.recovering && !this.recoveryVerified) this.denied()
      this.issuance ??= service.sessions.issueForAcceptedSession(context, new Date(action.expiresAt), 'opencode')
      this.token = await this.issuance
      if (this.revoked) {
        await service.sessions.revoke(this.token)
        this.denied()
      }
      return { token: this.token }
    }
    const caller = await this.caller(action.token, context)
    switch (action.phase) {
      case 'authenticate': return service.sessions.authenticate(action.token, action.tool)
      case 'service':
        switch (action.operation) {
          case 'list': return service.list(action.token, AgentFileListInputSchema.parse(action.input))
          case 'read': return service.read(action.token, AgentFileReadInputSchema.parse(action.input))
          case 'createWorkingCopy': return service.createWorkingCopy(action.token, AgentFileCreateWorkingCopyInputSchema.parse(action.input))
          case 'writeWorkingCopy': return service.writeWorkingCopy(action.token, AgentFileWriteWorkingCopyInputSchema.parse(action.input))
          case 'applyFormatEdit': return service.applyFormatEdit(action.token, AgentFileApplyFormatEditInputSchema.parse(action.input))
          case 'publish': return service.publish(action.token, AgentFilePublishInputSchema.parse(action.input))
          case 'publishedForTurn': return service.publishedForTurn(action.token)
        }
        break
      case 'artifact-get': return service.artifacts.get(caller, action.artifactId)
      case 'artifact-read': {
        const snapshot = await service.artifacts.readSnapshot(caller, action.artifactId, input.signal)
        const end = Math.min(snapshot.bytes.length, action.offset + action.length)
        if (action.offset > snapshot.bytes.length) this.denied()
        return { revision: snapshot.revision, offset: action.offset,
          contentBase64: snapshot.bytes.subarray(action.offset, end).toString('base64'), eof: end === snapshot.bytes.length }
      }
      case 'artifact-begin': return { writeId: await service.artifacts.beginWrite(action.token, action.artifactId, action.baseRevisionId) }
      case 'artifact-abort':
        await service.artifacts.abortWrite(action.token, action.artifactId, action.writeId)
        return { acknowledged: true }
      case 'write-begin':
      case 'write-chunk':
      case 'write-finish': return this.write(action, input.signal)
    }
    this.denied()
  }

  private async write(action: Extract<WorkerOpenCodeFileAction, {
    phase: 'write-begin' | 'write-chunk' | 'write-finish';
  }>, signal: AbortSignal): Promise<unknown> {
    let transfer = this.writes.get(action.transferId)
    const identity = { phase: 'write-begin' as const, token: action.token,
      artifactId: action.artifactId, transferId: action.transferId, writeId: action.writeId }
    if (action.phase === 'write-begin') {
      if (transfer && !isDeepStrictEqual(transfer.identity, identity)) this.denied()
      if (!transfer) {
        if (this.writes.size >= 20) this.denied()
        transfer = { identity, chunks: [], length: 0 }
        this.writes.set(action.transferId, transfer)
      }
      return { acknowledged: true }
    }
    if (!transfer || !isDeepStrictEqual(transfer.identity, identity)) this.denied()
    if (action.phase === 'write-chunk') {
      const bytes = Buffer.from(action.contentBase64, 'base64')
      if (bytes.toString('base64') !== action.contentBase64 || bytes.length > 65536 || transfer.completion) this.denied()
      if (action.offset < transfer.length) {
        const prior = Buffer.concat(transfer.chunks)
        if (!prior.subarray(action.offset, action.offset + bytes.length).equals(bytes)) this.denied()
      } else {
        if (action.offset !== transfer.length || transfer.length + bytes.length > MAX_FILE_BYTES) this.denied()
        transfer.chunks.push(bytes)
        transfer.length += bytes.length
      }
      return { acknowledged: true }
    }
    transfer.completion ??= this.ports.service().artifacts.completeWrite(action.token, action.artifactId,
      action.writeId, Readable.from(transfer.chunks), signal)
    await transfer.completion
    transfer.chunks = []
    return { acknowledged: true }
  }

  private async preserve(action: Extract<WorkerOpenCodeFileAction, {
    phase: 'preserve-begin' | 'preserve-chunk' | 'preserve-finish';
  }>, context: FileToolContext, signal: AbortSignal): Promise<unknown> {
    let transfer = this.versions.get(action.transferId)
    if (action.phase === 'preserve-begin') {
      if (transfer && !isDeepStrictEqual(transfer.identity, action)) this.denied()
      if (!transfer) {
        if (this.versions.size >= 20) this.denied()
        transfer = { identity: structuredClone(action), chunks: [], length: 0 }
        this.versions.set(action.transferId, transfer)
      }
      return { acknowledged: true }
    }
    if (!transfer) this.denied()
    if (action.phase === 'preserve-chunk') {
      const bytes = Buffer.from(action.contentBase64, 'base64')
      if (bytes.toString('base64') !== action.contentBase64 || bytes.length > 65536 || transfer.completion) this.denied()
      if (action.offset < transfer.length) {
        const prior = Buffer.concat(transfer.chunks)
        if (!prior.subarray(action.offset, action.offset + bytes.length).equals(bytes)) this.denied()
      } else {
        if (action.offset !== transfer.length || transfer.length + bytes.length > MAX_FILE_BYTES) this.denied()
        transfer.chunks.push(bytes)
        transfer.length += bytes.length
      }
      return { acknowledged: true }
    }
    transfer.completion ??= this.ports.service().preserveAccepted(context, {
      id: transfer.identity.id, revision: transfer.identity.revision, bytes: Buffer.concat(transfer.chunks),
    }, signal)
    await transfer.completion
    transfer.chunks = []
    return { acknowledged: true }
  }

  async close() {
    this.revoked = true
    if (this.issuance) this.token = await this.issuance
    if (this.token) await this.ports.service().sessions.revoke(this.token)
    this.writes.clear()
    this.versions.clear()
  }
}
