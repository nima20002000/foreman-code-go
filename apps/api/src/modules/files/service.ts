import { createHash, randomUUID } from 'node:crypto'
import type { Readable } from 'node:stream'
import {
  DEFAULT_FILE_RETENTION_SECONDS, FileRetentionDurationSchema, FileWithRevisionSchema,
  MessageAttachmentRefSchema, fileStateAt, temporaryFileExpiresAt,
  type TemporaryFileScope,
} from '@graphql/contracts/files'
import type { ManagementPrincipal } from '@graphql/contracts/management'

import { DomainError } from '../errors.js'
import type { FileConversation, FileConversationAuthorization } from './authorization.js'
import type { AllocationSession, FileAllocation, FileAllocationRepository, FileRepository, StoredFile } from './repository.js'
import { fileListInput, fileScopeIdentity, FileUploadRequestSchema } from './requests.js'
import type { FileByteStorage } from './storage.js'

export class TemporaryFileService {
  constructor(
    readonly repository: FileRepository & FileAllocationRepository,
    readonly bytes: FileByteStorage,
    private readonly authorization: FileConversationAuthorization,
    /** Retention integration supplies the authenticated-owner preference adapter; absence means the contract default. */
    private readonly retentionForOwner: (ownerPrincipalId: string) => Promise<number> = async () => DEFAULT_FILE_RETENTION_SECONDS,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  private now() { return this.clock().toISOString() }
  private matches(stored: StoredFile, scope: TemporaryFileScope) {
    if (stored.value.file.scope.kind !== 'temporary' || fileScopeIdentity(stored.value.file.scope) !== fileScopeIdentity(scope)) {
      throw new DomainError('FILE_NOT_FOUND', 'The pinned file revision was not found in this conversation.', 404)
    }
  }
  private async allocation(session: AllocationSession, scope: TemporaryFileScope): Promise<FileAllocation> {
    const allocation = await session.read()
    if (!allocation) throw new DomainError('FILE_UPLOAD_NOT_FOUND', 'The upload was not found.', 404)
    this.matches(allocation.stored, scope)
    return allocation
  }
  private live(allocation: FileAllocation) {
    const state = fileStateAt(allocation.stored.value.file, this.now())
    if (allocation.state === 'canceled' || state === 'removed') throw new DomainError('FILE_UPLOAD_CANCELED', 'The upload was canceled.', 409)
    if (state === 'expired') throw new DomainError('FILE_EXPIRED', 'The file has expired.', 410)
  }
  private result(allocation: FileAllocation, replayed: boolean) {
    const value = allocation.stored.value
    return { value: FileWithRevisionSchema.parse({ ...value, file: { ...value.file, state: fileStateAt(value.file, this.now()) } }), replayed }
  }

  async allocate(principal: ManagementPrincipal, target: FileConversation, input: unknown) {
    const scope = await this.authorization.resolve(principal, target, 'write')
    const request = FileUploadRequestSchema.parse(input)
    const inputHash = createHash('sha256').update(JSON.stringify([fileScopeIdentity(scope), request.filename,
      request.mediaType, request.byteSize, request.sha256])).digest('hex')
    // Preference read is outside the allocation lock; a replay always uses its persisted snapshot.
    const duration = FileRetentionDurationSchema.parse(await this.retentionForOwner(principal.id))
    return this.repository.withAllocation(principal.id, request.requestId, async (session) => {
      const existing = await session.read()
      if (existing) {
        if (existing.inputHash !== inputHash) throw new DomainError('FILE_REQUEST_CONFLICT', 'requestId was already used for different file metadata or a different conversation.', 409)
        this.matches(existing.stored, scope)
        return this.result(existing, true)
      }
      const now = this.now(), fileId = randomUUID(), revisionId = randomUUID()
      const value = FileWithRevisionSchema.parse({ file: { fileId, currentRevisionId: revisionId, scope,
        state: 'pending', createdAt: now, retentionDurationSeconds: duration, expiresAt: temporaryFileExpiresAt(now, duration) },
      revision: { fileId, revisionId, filename: request.filename, mediaType: request.mediaType,
        byteSize: request.byteSize, sha256: request.sha256, origin: 'upload', createdAt: now } })
      const allocation: FileAllocation = { allocationId: randomUUID(), requestId: request.requestId, inputHash,
        state: 'allocated', stored: { value, ownerPrincipalId: principal.id, storageKey: randomUUID() } }
      await session.create(allocation)
      return this.result(allocation, false)
    })
  }

  async upload(principal: ManagementPrincipal, target: FileConversation, requestId: string, source: Readable,
    options: { signal?: AbortSignal; reauthorize?: () => Promise<ManagementPrincipal> } = {}) {
    const scope = await this.authorization.resolve(principal, target, 'write')
    const initial = await this.repository.withAllocation(principal.id, requestId, async (session) => {
      const allocation = await this.allocation(session, scope); this.live(allocation); return allocation
    })
    // No pooled connection/transaction is held while reading the network body.
    const candidate = await this.bytes.receive(initial.stored.storageKey, source, initial.stored.value.revision, options.signal)
    try {
      const currentPrincipal = options.reauthorize ? await options.reauthorize() : principal
      if (currentPrincipal.id !== principal.id) throw new DomainError('AUTH_REQUIRED', 'Upload authentication changed.', 401)
      const currentScope = await this.authorization.resolve(currentPrincipal, target, 'write')
      this.matches(initial.stored, currentScope)
      return await this.repository.withAllocation(principal.id, requestId, async (session) => {
        const allocation = await this.allocation(session, currentScope); this.live(allocation)
        if (allocation.state === 'finalized') return this.result(allocation, true)
        await this.bytes.stage(candidate, allocation.stored.value.revision)
        return this.result(await session.setState('staged'), allocation.state === 'staged')
      })
    } finally { await this.bytes.discard(candidate) }
  }

  async finalize(principal: ManagementPrincipal, target: FileConversation, requestId: string) {
    const scope = await this.authorization.resolve(principal, target, 'write')
    return this.repository.withAllocation(principal.id, requestId, async (session) => {
      const allocation = await this.allocation(session, scope); this.live(allocation)
      if (allocation.state === 'finalized') {
        const stream = await this.bytes.download(allocation.stored.storageKey, allocation.stored.value.revision)
        stream.destroy()
        return this.result(allocation, true)
      }
      // 'allocated' is also recoverable: a prior process may have published staging before its SQL acknowledgement.
      await this.bytes.finalize(allocation.stored.storageKey, allocation.stored.value.revision)
      return this.result(await session.setState('finalized'), false)
    })
  }

  async list(principal: ManagementPrincipal, target: FileConversation, query: unknown) {
    const scope = await this.authorization.resolve(principal, target, 'read')
    const input = fileListInput(scope, query)
    return this.repository.list(scope, { limit: input.limit, ...(input.cursor ? { cursor: input.cursor } : {}) }, this.now())
  }

  async download(principal: ManagementPrincipal, target: FileConversation, pins: unknown) {
    const scope = await this.authorization.resolve(principal, target, 'read')
    const ref = MessageAttachmentRefSchema.parse(pins)
    const stored = await this.repository.read(ref.fileId, ref.revisionId)
    if (!stored) throw new DomainError('FILE_NOT_FOUND', 'The pinned file revision was not found in this conversation.', 404)
    this.matches(stored, scope)
    const state = fileStateAt(stored.value.file, this.now())
    if (state === 'pending') throw new DomainError('FILE_NOT_READY', 'The upload has not been finalized.', 409)
    if (state !== 'ready') throw new DomainError('FILE_BYTES_UNAVAILABLE', 'The pinned file bytes are no longer available.', 410)
    const stream = await this.bytes.download(stored.storageKey, stored.value.revision)
    // Verification can take time; expiry remains absolute rather than a sliding lease.
    if (fileStateAt(stored.value.file, this.now()) !== 'ready') {
      stream.destroy(); throw new DomainError('FILE_EXPIRED', 'The file has expired.', 410)
    }
    return { revision: stored.value.revision, stream }
  }

  async cancel(principal: ManagementPrincipal, target: FileConversation, requestId: string) {
    const scope = await this.authorization.resolve(principal, target, 'write')
    return this.repository.withAllocation(principal.id, requestId, async (session) => {
      const allocation = await this.allocation(session, scope)
      if (allocation.state === 'finalized' || allocation.stored.value.file.state === 'ready') {
        throw new DomainError('FILE_ALREADY_FINALIZED', 'Only unsent staging can be canceled; finalized files cannot be deleted through this route.', 409)
      }
      // Tombstone first. Retry also removes bytes after a crash or filesystem failure.
      const canceled = await session.setState('canceled')
      await this.bytes.removeUnsent(canceled.stored.storageKey)
      return this.result(canceled, allocation.state === 'canceled')
    })
  }
}
