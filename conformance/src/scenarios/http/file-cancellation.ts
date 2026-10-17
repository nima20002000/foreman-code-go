import { FileWithRevisionSchema, type FileWithRevision } from '@foreman-code/contracts/files'
import { assertResponse } from '../../assertions.js'
import type { ScenarioContext } from '../../scenario.js'
import type { CodecFixture } from '../codecs/fixtures.js'
import { assertApiError } from '../smoke/support.js'
import { fileContentPath } from './file-support.js'

export async function cancelStagedFile(ctx: ScenarioContext, path: string, requestId: string,
  pending: FileWithRevision, fixture: CodecFixture) {
  const uploadPath = `${path}/uploads/${requestId}`
  const removed = FileWithRevisionSchema.parse({ ...pending, file: { ...pending.file, state: 'removed' } })
  assertResponse(await ctx.http.request('DELETE', uploadPath), {
    status: 200, body: { value: removed, replayed: false },
  })
  assertResponse(await ctx.http.request('DELETE', uploadPath), {
    status: 200, body: { value: removed, replayed: true },
  })
  assertApiError(await ctx.http.upload(uploadPath, fixture.bytes),
    409, 'FILE_UPLOAD_CANCELED', 'The upload was canceled.')
  assertApiError(await ctx.http.request('POST', `${uploadPath}/finalize`, { body: {} }),
    409, 'FILE_UPLOAD_CANCELED', 'The upload was canceled.')
  assertApiError(await ctx.http.request('GET', fileContentPath(path, removed)),
    410, 'FILE_BYTES_UNAVAILABLE', 'The pinned file bytes are no longer available.')
  return removed
}
