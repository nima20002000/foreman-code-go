import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { FileWithRevision } from '@foreman-code/contracts/files'
import { assertResponse } from '../../assertions.js'
import type { ScenarioContext } from '../../scenario.js'
import type { CodecFixture } from '../codecs/fixtures.js'
import { assertApiError } from '../smoke/support.js'
import { fileContentPath } from './file-support.js'

/** Every rejected write is followed by the caller's full pending-record readback. */
export async function assertUploadRejections(ctx: ScenarioContext, path: string, requestId: string,
  pending: FileWithRevision, fixture: CodecFixture): Promise<void> {
  const uploadPath = `${path}/uploads/${requestId}`
  assertApiError(await ctx.http.request('POST', `${uploadPath}/finalize`, { body: {} }),
    409, 'FILE_UPLOAD_INCOMPLETE', 'Upload verified bytes before finalizing.')
  assertApiError(await ctx.http.request('GET', fileContentPath(path, pending)),
    409, 'FILE_NOT_READY', 'The upload has not been finalized.')
  assertResponse(await ctx.http.request('HEAD', fileContentPath(path, pending)), { status: 409, body: null })
  assertApiError(await ctx.http.request('PUT', uploadPath, { body: {} }),
    415, 'FILE_CONTENT_TYPE_INVALID', 'Upload raw application/octet-stream bytes without content encoding.')
  assertApiError(await ctx.http.upload(uploadPath, fixture.bytes, { token: 'conformance-invalid-credential' }),
    401, 'AUTH_INVALID', 'The supplied credential is invalid.')

  assert.ok(fixture.bytes.byteLength > 1, 'The byte-integrity case needs a nonempty committed fixture')
  assertApiError(await ctx.http.upload(uploadPath, fixture.bytes.subarray(0, -1)),
    422, 'FILE_SIZE_MISMATCH', 'The upload ended before its allocated byte count.')
  const incorrectBytes = Uint8Array.from(fixture.bytes)
  incorrectBytes[0] = incorrectBytes[0]! ^ 0xff
  assertApiError(await ctx.http.upload(uploadPath, incorrectBytes),
    422, 'FILE_HASH_MISMATCH', 'The uploaded SHA-256 differs from its allocation.')
  assertApiError(await ctx.http.request('DELETE', `${path}/uploads/${randomUUID()}`),
    404, 'FILE_UPLOAD_NOT_FOUND', 'The upload was not found.')
}
