import { randomBytes, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { FileRevision, MessageAttachmentRef } from '@graphql/contracts/files'
import type { FileToolContext } from '../../src/modules/files/tools/types.js'
import { sha256 } from '../../src/modules/harnesses/opencodeFiles/attachments.js'
import type { OpenCodeExecutionFiles, OpenCodeFileService } from '../../src/modules/harnesses/opencodeFiles/types.js'

export const fileTools = ['files.list', 'files.read', 'files.create_working_copy', 'files.publish_result'] as const
export const fileScope = { kind: 'temporary' as const, chat: { kind: 'agent' as const,
  conversationId: 'conversation-a', agentId: 'agent-1', workspaceId: 'workspace-a', workflowId: 'workflow-a' } }
export function fileContext(overrides: Partial<FileToolContext> = {}): FileToolContext {
  return { ownerPrincipalId: 'human-a', scope: structuredClone(fileScope), nativeSessionId: 'ses_test',
    turnId: 'turn-a', messageId: 'message-a', allowMutation: true, allowedTools: [...fileTools], ...overrides }
}
const denied = (code: string) => Object.assign(new Error(code), { code })
export const hasFileCode = (code: string) => (error: unknown) =>
  !!error && typeof error === 'object' && 'code' in error && error.code === code
export const fileSignal = () => AbortSignal.timeout(10_000)

/** FIL-05-shaped fake. Native manager integration uses the existing FixtureServer;
 * the standalone bridge cases need only this backend and an HTTP MCP/config fake.
 */
export function createChatFileBackend() {
  const audit: string[] = []
  const values = new Map<string, { revision: FileRevision; bytes: Buffer; expired: boolean }>()
  const sessions = new Map<string, { context: FileToolContext; expiresAt: Date }>()
  const issued: { token: string; context: FileToolContext }[] = []
  const artifacts = new Map<string, { bytes: Buffer; state: string; writeId: string; binding: string; source: MessageAttachmentRef }>()
  const copies = new Map<string, string>()
  const receipts = new Map<string, { hash: string; result: unknown }>()
  const ledger = new Map<string, MessageAttachmentRef[]>()
  const messages = new Map<string, MessageAttachmentRef[]>()
  const adopted: FileToolContext[] = []
  const hostFiles = new Map<string, { bytes: Uint8Array; writable: boolean }>()
  const key = (ref: MessageAttachmentRef) => `${ref.fileId}/${ref.revisionId}`
  const binding = (context: FileToolContext) => sha256(JSON.stringify([
    context.ownerPrincipalId, context.scope, context.nativeSessionId, context.turnId, context.messageId,
  ]))
  let revokeFailure = false, adoptFailure = false, publishAckLost = false, ownerRevoked = false
  let revocations = 0, reads = 0, copiesMade = 0, materializations = 0, removeFailure = false
  const createdAt = '2026-09-01T00:00:00.000Z'
  const authorizeContext = (context: FileToolContext, tool?: string) => {
    if (ownerRevoked || context.ownerPrincipalId !== 'human-a' || !isDeepStrictEqual(context.scope, fileScope)) throw denied('FILE_CONTEXT_DENIED')
    if (tool && (!context.allowedTools.includes(tool as typeof fileTools[number])
      || (!context.allowMutation && ['files.create_working_copy', 'files.publish_result'].includes(tool)))) throw denied('FILE_TOOL_DENIED')
    return { context, principal: { id: context.ownerPrincipalId }, binding: binding(context) }
  }
  const authenticate = async (token?: string, tool?: string) => {
    const stored = token ? sessions.get(token) : undefined
    if (!stored || stored.expiresAt.getTime() <= Date.now()) throw denied('FILE_SESSION_EXPIRED')
    return authorizeContext(stored.context, tool)
  }
  function add(text = '# input\n', mediaType: FileRevision['mediaType'] = 'text/markdown', filename = 'input.md') {
    const ref = { fileId: randomUUID(), revisionId: randomUUID() }
    const bytes = Buffer.from(text)
    const revision: FileRevision = { ...ref, filename, mediaType, byteSize: bytes.length,
      sha256: sha256(bytes), origin: 'upload', createdAt }
    values.set(key(ref), { revision, bytes, expired: false })
    return ref
  }
  const file = (ref: MessageAttachmentRef) => ({ fileId: ref.fileId, currentRevisionId: ref.revisionId,
    scope: structuredClone(fileScope), state: 'ready', createdAt, retentionDurationSeconds: 365 * 24 * 60 * 60,
    expiresAt: '2027-09-01T00:00:00.000Z' })
  const readRange = (input: MessageAttachmentRef & { offset?: number; length?: number }) => {
    audit.push('read'); reads++
    const entry = values.get(key(input))
    if (!entry || entry.expired) return { status: 'unavailable', ref: input, reason: 'expired' }
    const offset = input.offset ?? 0, length = input.length ?? 65_536
    const bytes = entry.bytes.subarray(offset, offset + length)
    return { status: 'ready', file: file(input), revision: entry.revision, readAt: new Date().toISOString(),
      offset, byteLength: bytes.length, contentBase64: bytes.toString('base64'), eof: offset + bytes.length === entry.bytes.length }
  }
  const api = {
    sessions: {
      authenticate,
      async issueForAcceptedSession(context: FileToolContext, expiresAt: Date) {
        authorizeContext(context)
        audit.push('issue')
        const token = `gql_file_${randomBytes(32).toString('base64url')}`
        sessions.set(token, { context: structuredClone(context), expiresAt })
        issued.push({ token, context: structuredClone(context) })
        return token
      },
      async revoke(token: string) {
        audit.push('revoke')
        if (revokeFailure) throw new Error('fixture revoke unavailable')
        sessions.delete(token); revocations++
      },
    },
    artifacts: {
      async get(caller: { binding: string }, id: string) {
        const entry = artifacts.get(id)
        if (!entry || entry.binding !== caller.binding) throw denied('FILE_ARTIFACT_NOT_FOUND')
        return { ...entry, artifactId: id }
      },
      async beginWrite(token: string, id: string) {
        const caller = await authenticate(token, 'files.publish_result')
        const entry = artifacts.get(id)
        if (!entry || entry.binding !== caller.binding) throw denied('FILE_ARTIFACT_NOT_FOUND')
        if (entry.state === 'writing') throw denied('FILE_ARTIFACT_BUSY')
        entry.state = 'writing'; entry.writeId = randomUUID(); return entry.writeId
      },
      async completeWrite(token: string, id: string, writeId: string, source: AsyncIterable<Uint8Array>) {
        const caller = await authenticate(token, 'files.publish_result')
        const entry = artifacts.get(id)
        if (!entry || entry.binding !== caller.binding || entry.writeId !== writeId) throw denied('FILE_ARTIFACT_WRITE_STALE')
        const chunks: Uint8Array[] = []; for await (const chunk of source) chunks.push(chunk)
        entry.bytes = Buffer.concat(chunks); entry.state = 'complete'
      },
      async abortWrite(token: string, id: string, writeId: string) {
        const caller = await authenticate(token, 'files.publish_result')
        const entry = artifacts.get(id)
        if (!entry || entry.binding !== caller.binding || entry.writeId !== writeId) throw denied('FILE_ARTIFACT_WRITE_STALE')
        entry.state = 'failed'
      },
    },
    async list(token: string) { await authenticate(token, 'files.list'); return { items: [], pageInfo: { nextCursor: null } } },
    async read(token: string, input: MessageAttachmentRef & { offset?: number; length?: number }) {
      await authenticate(token, 'files.read'); return readRange(input)
    },
    async createWorkingCopy(token: string, input: { commandId: string; source: MessageAttachmentRef; destination: unknown }) {
      const caller = await authenticate(token, 'files.create_working_copy')
      if (!isDeepStrictEqual(input.destination, caller.context.scope)) throw denied('FILE_CONTEXT_DENIED')
      const original = values.get(key(input.source))
      if (!original || original.expired) throw denied('FILE_ATTACHMENT_UNAVAILABLE')
      const command = `${caller.binding}:${input.commandId}`
      let id = copies.get(command)
      const replayed = !!id
      if (!id) {
        id = randomUUID(); copies.set(command, id); copiesMade++
        artifacts.set(id, { bytes: Buffer.from(original.bytes), source: input.source,
          state: 'complete', writeId: randomUUID(), binding: caller.binding })
      }
      return { value: { artifactId: id, source: input.source, destination: input.destination,
        filename: original.revision.filename, createdAt }, replayed }
    },
    async publish(token: string, input: { commandId: string; artifactId: string; filename: string; mediaType: FileRevision['mediaType']; scope: unknown }) {
      const caller = await authenticate(token, 'files.publish_result')
      const entry = artifacts.get(input.artifactId)
      if (!entry || entry.binding !== caller.binding || entry.state !== 'complete') throw denied('FILE_ARTIFACT_INCOMPLETE')
      if (!isDeepStrictEqual(input.scope, caller.context.scope)) throw denied('FILE_CONTEXT_DENIED')
      const command = `${caller.binding}:${input.commandId}`
      const hash = sha256(JSON.stringify([input, entry.bytes.toString('base64')]))
      const old = receipts.get(command)
      if (old && old.hash !== hash) throw denied('FILE_REQUEST_CONFLICT')
      if (old) return { ...(old.result as object), replayed: true }
      const ref = add(entry.bytes.toString(), input.mediaType, input.filename)
      const revision = { ...values.get(key(ref))!.revision, origin: 'agent_output' }
      const result = { value: { file: file(ref), revision }, replayed: false }
      const published = ledger.get(caller.binding) ?? []
      published.push(ref); ledger.set(caller.binding, published)
      receipts.set(command, { hash, result })
      audit.push('publish')
      if (publishAckLost) { publishAckLost = false; throw new Error('fixture lost publish ack') }
      return result
    },
    async publishedForTurn(token: string) {
      const caller = await authenticate(token, 'files.list'); return ledger.get(caller.binding) ?? []
    },
  }
  const service = api as unknown as OpenCodeFileService
  const host: OpenCodeExecutionFiles = {
    executionHostId: 'execution-b',
    async assertSourceIsolation() { audit.push('isolation') },
    async materialize(input) {
      materializations++; audit.push('materialize')
      hostFiles.set(input.handle, { bytes: Uint8Array.from(input.bytes), writable: input.writable })
      return { handle: input.handle, executionHostId: 'execution-b', path: `/execution/b/${input.handle}/${input.revision.filename}` }
    },
    async snapshot(handle) {
      const entry = hostFiles.get(handle)
      if (!entry) throw denied('FILE_ARTIFACT_NOT_FOUND')
      return Uint8Array.from(entry.bytes)
    },
    async remove(handle) {
      audit.push('remove')
      if (removeFailure) throw new Error('fixture remove unavailable')
      hostFiles.delete(handle)
    },
  }
  return {
    service, host, audit, values, hostFiles, issued, messages, adopted, add,
    readAccepted(context: FileToolContext): import('../../src/modules/harnesses/opencodeFiles/types.js').OpenCodeAcceptedFileReader {
      return async (input, signal) => {
        signal.throwIfAborted(); authorizeContext(context, 'files.read')
        return readRange(input) as Awaited<ReturnType<OpenCodeFileService['read']>>
      }
    },
    async adoptPublished(context: FileToolContext) {
      audit.push('adopt')
      if (adoptFailure) throw new Error('fixture adoption unavailable')
      // Unlike tool reads this is an internal durable-ledger recovery operation.
      // It is still bound to the original persisted owner/scope/session/turn/message.
      if (!context.messageId || context.ownerPrincipalId !== 'human-a'
        || !isDeepStrictEqual(context.scope, fileScope)) throw denied('FILE_CONTEXT_DENIED')
      const refs = ledger.get(binding(context)) ?? []
      const existing = messages.get(context.messageId) ?? []
      for (const ref of refs) if (!existing.some((old) => key(old) === key(ref))) existing.push(structuredClone(ref))
      messages.set(context.messageId, existing); adopted.push(structuredClone(context))
    },
    get token() { const value = issued.at(-1); if (!value) throw new Error('No issued token'); return value.token },
    get reads() { return reads }, get revocations() { return revocations }, get copiesMade() { return copiesMade },
    get materializations() { return materializations },
    failRevoke(value: boolean) { revokeFailure = value }, failAdopt(value: boolean) { adoptFailure = value },
    failRemove(value: boolean) { removeFailure = value }, losePublishAck() { publishAckLost = true },
    revokeOwner() { ownerRevoked = true },
  }
}
