import { Readable } from 'node:stream'
import { isDeepStrictEqual as same } from 'node:util'
import { z } from 'zod'
import type pg from 'pg'
import { ArtifactAttemptSchema } from '@graphql/contracts/artifact-edges'
import { AgentFilePublishInputSchema, AgentFilePublishResultSchema, FileSha256Schema,
  MAX_FILE_BYTES } from '@graphql/contracts/files'
import type { TemporaryFileService } from '../service.js'
import type { PublicationLink } from '../tools/types.js'
import { digest, targetOf } from '../tools/context.js'
import { fileScopeIdentity } from '../requests.js'
import type { ArtifactPublicationAuthority, AcceptedMainArtifactPublication } from './publication.js'
import type { CanonicalNativeArtifactResult } from './nativeResults.js'
import type { WorkerNativeArtifactSnapshot } from '../../runs/remote/workerNativeArtifactSender.js'
import { PostgresFileToolRepository } from '../tools/postgres.js'
import { DomainError } from '../../errors.js'

export const MainArtifactPublicationSchema = z.object({ kind: z.literal('main'), mainId: z.uuid(),
  attempt: ArtifactAttemptSchema, sha256: FileSha256Schema,
  byteSize: z.number().int().min(0).max(MAX_FILE_BYTES) }).strict()
export type MainArtifactPublication = z.infer<typeof MainArtifactPublicationSchema>
interface MainPublicationLink extends PublicationLink {
  mainPublication: MainArtifactPublication
  publicationInputHash: string
}
export interface MainPublicationLedger {
  read(ownerPrincipalId: string, requestId: string): Promise<MainPublicationLink | undefined>
  linkPublication(link: MainPublicationLink): Promise<void>
}
export class PostgresMainPublicationLedger implements MainPublicationLedger {
  private readonly ledger: PostgresFileToolRepository
  constructor(private readonly pool: pg.Pool) { this.ledger = new PostgresFileToolRepository(pool) }
  async read(ownerPrincipalId: string, requestId: string) {
    return (await this.pool.query<{ record: MainPublicationLink }>(
      'select record from file_tool_publications where owner_principal_id=$1 and request_id=$2',
      [ownerPrincipalId, requestId])).rows[0]?.record
  }
  async linkPublication(link: MainPublicationLink) {
    await this.ledger.linkPublication(link)
    if (!same(await this.read(link.ownerPrincipalId, link.requestId), link)) throw conflict()
  }
}
export type CanonicalMainArtifactResult = Omit<CanonicalNativeArtifactResult, 'transferReceipt'> & {
  mainPublication: MainArtifactPublication
}
const conflict = () => new DomainError('FILE_PUBLICATION_CONFLICT',
  'The publication does not belong to this original native attempt.', 409)

/** Local outputs use canonical allocation and publication ledgers without fabricating
 * a device connection or byte-transfer receipt for bytes already on Main. */
export class MainArtifactPublications {
  constructor(private readonly files: TemporaryFileService,
    private readonly ledger: MainPublicationLedger,
    private readonly authority: Pick<ArtifactPublicationAuthority, 'authorize'>,
    private readonly clock: () => Date = () => new Date()) {}
  async publish(accepted: AcceptedMainArtifactPublication, raw: unknown, snapshot: WorkerNativeArtifactSnapshot,
    signal?: AbortSignal) {
    const input = AgentFilePublishInputSchema.parse(raw)
    const caller = await this.authority.authorize(accepted)
    if (!caller.context.allowMutation || !caller.context.allowedTools.includes('files.publish_result')
      || fileScopeIdentity(input.scope) !== fileScopeIdentity(caller.context.scope)) throw conflict()
    const mainPublication = MainArtifactPublicationSchema.parse({ ...accepted.location, attempt: accepted.attempt,
      sha256: snapshot.sha256, byteSize: snapshot.byteSize })
    const requestId = `fil05:main:${digest(input.commandId)}`
    const inputHash = digest(JSON.stringify([input, caller.binding, mainPublication]))
    const original = await this.ledger.read(caller.principal.id, requestId)
    if (original && (original.publicationInputHash !== inputHash || !same(original.mainPublication, mainPublication))) {
      throw conflict()
    }
    const check = async (query?: Parameters<ArtifactPublicationAuthority['authorize']>[1]) => {
      signal?.throwIfAborted()
      await snapshot.assertCurrent(signal)
      const current = await this.authority.authorize(accepted, query)
      if (current.principal.id !== caller.principal.id || current.binding !== caller.binding) throw conflict()
      return current
    }
    const guard = { source: 'mcp' as const, authorize: async (query: NonNullable<Parameters<typeof check>[0]>) => {
      await check(query)
    } }
    await check()
    const allocated = await this.files.allocateAgentResult(caller.principal, targetOf(caller.context), {
      requestId, filename: input.filename, mediaType: input.mediaType,
      sha256: snapshot.sha256, byteSize: snapshot.byteSize,
    }, 'agent_output', inputHash, guard)
    await this.ledger.linkPublication({ ownerPrincipalId: caller.principal.id, requestId, binding: caller.binding,
      context: caller.context, ref: { fileId: allocated.value.file.fileId,
        revisionId: allocated.value.revision.revisionId },
      createdAt: original?.createdAt ?? this.clock().toISOString(), mainPublication, publicationInputHash: inputHash } as MainPublicationLink)
    if (allocated.value.file.state !== 'ready') {
      const stream = Readable.from((async function* () {
        for (let offset = 0; offset < snapshot.byteSize;) {
          await check()
          const length = Math.min(65_536, snapshot.byteSize - offset)
          const bytes = await snapshot.read(offset, length, signal)
          if (bytes.length !== length) throw conflict()
          offset += length
          yield bytes
        }
      })())
      try {
        await this.files.upload(caller.principal, targetOf(caller.context), requestId, stream, {
          reauthorize: async () => (await check()).principal, commitAuthorization: guard,
          signal: signal ?? AbortSignal.timeout(120_000), source: 'mcp',
        })
      } finally { stream.destroy() }
    }
    const current = await check()
    const result = await this.files.finalize(current.principal, targetOf(current.context), requestId, 'mcp', guard)
    await check()
    return AgentFilePublishResultSchema.parse({ value: result.value, replayed: allocated.replayed })
  }
  async readAccepted(accepted: AcceptedMainArtifactPublication, commandId: string): Promise<CanonicalMainArtifactResult> {
    const caller = await this.authority.authorize(accepted)
    if (!caller.context.allowedTools.includes('files.list')) throw conflict()
    const requestId = `fil05:main:${digest(AgentFilePublishInputSchema.shape.commandId.parse(commandId))}`
    const link = await this.ledger.read(caller.principal.id, requestId)
    if (!link || !link.publicationInputHash || link.binding !== caller.binding
      || !same(link.context, caller.context)) throw conflict()
    const mainPublication = MainArtifactPublicationSchema.parse(link.mainPublication)
    if (mainPublication.mainId !== accepted.location.mainId || !same(mainPublication.attempt, accepted.attempt)) {
      throw conflict()
    }
    const opened = await this.files.download(caller.principal, targetOf(caller.context), link.ref)
    try {
      if (opened.revision.sha256 !== mainPublication.sha256 || opened.revision.byteSize !== mainPublication.byteSize) {
        throw conflict()
      }
    } finally { opened.stream.destroy() }
    const current = await this.authority.authorize(accepted)
    const stored = await this.files.repository.read(link.ref.fileId, link.ref.revisionId)
    if (!stored || current.binding !== caller.binding || current.principal.id !== caller.principal.id
      || stored.value.file.state !== 'ready' || !('expiresAt' in stored.value.file)
      || Date.parse(stored.value.file.expiresAt) <= this.clock().getTime()
      || stored.value.revision.sha256 !== mainPublication.sha256
      || stored.value.revision.byteSize !== mainPublication.byteSize
      || fileScopeIdentity(stored.value.file.scope) !== fileScopeIdentity(caller.context.scope)) throw conflict()
    return { attempt: structuredClone(accepted.attempt),
      nativeIdentity: { nativeSessionId: caller.context.nativeSessionId,
        ...(caller.context.turnId ? { turnId: caller.context.turnId } : {}) },
      publication: { ownerPrincipalId: caller.principal.id, requestId, binding: caller.binding },
      pins: { ...link.ref, sha256: mainPublication.sha256, byteSize: mainPublication.byteSize },
      value: stored.value, mainPublication }
  }
}
