import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  FileDescriptionSchema,
  FileRetentionDurationSchema,
  FileWithRevisionSchema,
  temporaryFileExpiresAt,
  type FileWithRevision,
  type PermanentFileScope,
  type TemporaryFileScope,
} from '@foreman-code/contracts/files'
import { assertResponse } from '../../assertions.js'
import type { PublicResponse } from '../../clients/http.js'
import type { ScenarioContext } from '../../scenario.js'
import type { CodecFixture } from '../codecs/fixtures.js'

/** The upload transport envelope composes the shared immutable file contract. */
export const fileMutationSchema = z.object({ value: FileWithRevisionSchema, replayed: z.boolean() }).strict()

export function fileContentPath(path: string, value: FileWithRevision): string {
  return `${path}/${value.revision.fileId}/revisions/${value.revision.revisionId}/content`
}

export function fileListBody(files: readonly FileWithRevision[]) {
  const items = [...files].sort((left, right) => {
    const byCreation = Date.parse(left.file.createdAt) - Date.parse(right.file.createdAt)
    if (byCreation !== 0) return byCreation
    return left.file.fileId.localeCompare(right.file.fileId)
  })
  return { items, pageInfo: { nextCursor: null } }
}

export async function allocateFile(ctx: ScenarioContext, path: string, fixture: CodecFixture,
  scope: PermanentFileScope | TemporaryFileScope, retentionDurationSeconds?: number) {
  const description = FileDescriptionSchema.parse({ filename: fixture.filename, mediaType: fixture.mediaType })
  const input = { requestId: randomUUID(), ...description, byteSize: fixture.bytes.byteLength, sha256: fixture.sha256 }
  const response = await ctx.http.request('POST', `${path}/uploads`, { body: input })
  const pending = fileMutationSchema.parse(response.body).value
  let retention = {}
  if (scope.kind === 'temporary') {
    const duration = FileRetentionDurationSchema.parse(retentionDurationSeconds)
    retention = {
      retentionDurationSeconds: duration,
      expiresAt: temporaryFileExpiresAt(pending.file.createdAt, duration),
    }
  } else {
    assert.equal(retentionDurationSeconds, undefined, 'Permanent references have no retention snapshot')
  }
  assertResponse(response, { status: 201, body: { value: {
    file: {
      fileId: '<uuid>', currentRevisionId: '<uuid>', scope, state: 'pending', createdAt: '<timestamp>', ...retention,
    },
    revision: {
      fileId: pending.file.fileId, revisionId: pending.file.currentRevisionId,
      ...description, byteSize: fixture.bytes.byteLength, sha256: fixture.sha256,
      origin: 'upload', createdAt: pending.file.createdAt,
    },
  }, replayed: false } }, [
    { pointer: '/body/value/file/fileId', kind: 'uuid' },
    { pointer: '/body/value/file/currentRevisionId', kind: 'uuid' },
    { pointer: '/body/value/file/createdAt', kind: 'timestamp' },
  ])
  assertResponse(await ctx.http.request('POST', `${path}/uploads`, { body: input }), {
    status: 200, body: { value: pending, replayed: true },
  })
  return { input, pending }
}

export async function finalizeFile(ctx: ScenarioContext, path: string, requestId: string, pending: FileWithRevision) {
  const value = FileWithRevisionSchema.parse({ ...pending, file: { ...pending.file, state: 'ready' } })
  assertResponse(await ctx.http.request('POST', `${path}/uploads/${requestId}/finalize`, { body: {} }), {
    status: 200, body: { value, replayed: false },
  })
  assertResponse(await ctx.http.request('POST', `${path}/uploads/${requestId}/finalize`, { body: {} }), {
    status: 200, body: { value, replayed: true },
  })
  return value
}

function assertDownloadHeaders(response: Pick<PublicResponse, 'headers'>, fixture: CodecFixture): void {
  assert.equal(response.headers.get('content-type'), fixture.mediaType)
  assert.equal(response.headers.get('content-length'), String(fixture.bytes.byteLength))
  assert.equal(response.headers.get('content-disposition'),
    `attachment; filename="${fixture.filename}"; filename*=UTF-8''${encodeURIComponent(fixture.filename)}`)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(response.headers.get('content-security-policy'), "sandbox; default-src 'none'")
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin')
  assert.equal(response.headers.get('accept-ranges'), 'none')
}

export async function assertFileDownload(ctx: ScenarioContext, path: string, fixture: CodecFixture): Promise<void> {
  const response = await ctx.http.download(path)
  assert.equal(response.status, 200)
  assertDownloadHeaders(response, fixture)
  assert.deepStrictEqual(response.body, fixture.bytes)
  const head = await ctx.http.request('HEAD', path)
  assertResponse(head, { status: 200, body: null })
  assertDownloadHeaders(head, fixture)
}
