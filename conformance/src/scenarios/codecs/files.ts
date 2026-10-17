import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { LocalHumanAccessSchema, ManagementActionSchema } from '@foreman-code/contracts/management'
import {
  DEFAULT_FILE_RETENTION_SECONDS, FileDescriptionSchema, FilePageSchema,
  FileWithRevisionSchema, TemporaryFileScopeSchema, temporaryFileExpiresAt,
  type FileWithRevision,
} from '@foreman-code/contracts/files'
import { assertResponse } from '../../assertions.js'
import type { ScenarioContext } from '../../scenario.js'
import type { CodecFixture } from './fixtures.js'
import { bytesSha256 } from './fixtures.js'

// The HTTP upload envelope composes the canonical file record; metadata is never redefined here.
const FileMutationResultSchema = z.object({ value: FileWithRevisionSchema, replayed: z.boolean() }).strict()

export function conversationFilesPath(conversationId: string) {
  return `/api/operator/conversations/${conversationId}/files`
}

export async function uploadConversationFile(ctx: ScenarioContext, conversationId: string, fixture: CodecFixture) {
  const callerResponse = await ctx.http.request('GET', '/api/local-human')
  const { principal } = LocalHumanAccessSchema.parse(callerResponse.body)
  assertResponse(callerResponse, { status: 200, body: { principal: {
    id: 'principal-local-human', name: 'Local human', expiresAt: '9999-12-31T23:59:59.000Z',
    grants: [{ actions: [...ManagementActionSchema.options], scope: {} }],
  } } })
  const description = FileDescriptionSchema.parse({ filename: fixture.filename, mediaType: fixture.mediaType })
  const input = { requestId: randomUUID(), ...description, byteSize: fixture.bytes.byteLength, sha256: fixture.sha256 }
  const path = conversationFilesPath(conversationId)
  const allocated = await ctx.http.request('POST', `${path}/uploads`, { body: input })
  const { value: pending } = FileMutationResultSchema.parse(allocated.body)
  const scope = TemporaryFileScopeSchema.parse(pending.file.scope)
  assert.ok(scope.chat.kind === 'operator')
  assertResponse(allocated, { status: 201, body: { value: {
    file: { fileId: '<uuid>', currentRevisionId: '<uuid>',
      scope: { kind: 'temporary', chat: { kind: 'operator', ownerPrincipalId: principal.id,
        operatorId: 'application-operator', conversationId } },
      state: 'pending', createdAt: '<timestamp>', retentionDurationSeconds: DEFAULT_FILE_RETENTION_SECONDS,
      expiresAt: temporaryFileExpiresAt(pending.file.createdAt, DEFAULT_FILE_RETENTION_SECONDS) },
    revision: { fileId: pending.file.fileId, revisionId: pending.file.currentRevisionId,
      ...description, byteSize: fixture.bytes.byteLength, sha256: fixture.sha256,
      origin: 'upload', createdAt: pending.file.createdAt },
  }, replayed: false } }, [
    { pointer: '/body/value/file/fileId', kind: 'uuid' },
    { pointer: '/body/value/file/currentRevisionId', kind: 'uuid' },
    { pointer: '/body/value/file/createdAt', kind: 'timestamp' },
  ])
  const upload = await ctx.http.upload(`${path}/uploads/${input.requestId}`, fixture.bytes)
  assertResponse(upload, {
    status: 200, body: { value: pending, replayed: false },
  })
  const finalized = await ctx.http.request('POST', `${path}/uploads/${input.requestId}/finalize`, { body: {} })
  const { value } = FileMutationResultSchema.parse(finalized.body)
  assertResponse(finalized, { status: 200, body: {
    value: { ...pending, file: { ...pending.file, state: 'ready' } }, replayed: false,
  } })
  assertResponse(await ctx.http.request('POST', `${path}/uploads/${input.requestId}/finalize`, { body: {} }), {
    status: 200, body: { value, replayed: true },
  })
  await assertFileList(ctx, conversationId, [value])
  assert.deepStrictEqual(await downloadConversationFile(ctx, conversationId, value), fixture.bytes)
  return { value, scope, requestId: input.requestId,
    ref: { fileId: value.file.fileId, revisionId: value.revision.revisionId } }
}

export async function assertFileList(ctx: ScenarioContext, conversationId: string, files: FileWithRevision[]) {
  const response = await ctx.http.request('GET', conversationFilesPath(conversationId))
  FilePageSchema.parse(response.body)
  assertResponse(response, { status: 200, body: { items: files, pageInfo: { nextCursor: null } } })
}

export async function downloadConversationFile(ctx: ScenarioContext, conversationId: string, value: FileWithRevision) {
  const revision = value.revision
  const path = `${conversationFilesPath(conversationId)}/${revision.fileId}/revisions/${revision.revisionId}/content`
  const response = await ctx.http.download(path)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), revision.mediaType)
  assert.equal(response.headers.get('content-length'), String(revision.byteSize))
  assert.equal(response.headers.get('content-disposition'),
    `attachment; filename="${revision.filename}"; filename*=UTF-8''${encodeURIComponent(revision.filename)}`)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(response.headers.get('content-security-policy'), "sandbox; default-src 'none'")
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin')
  assert.equal(response.headers.get('accept-ranges'), 'none')
  const bytes = response.body
  assert.equal(bytes.byteLength, revision.byteSize)
  assert.equal(bytesSha256(bytes), revision.sha256)
  return bytes
}
