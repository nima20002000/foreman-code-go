import { randomUUID } from 'node:crypto'
import { DEFAULT_FILE_RETENTION_SECONDS } from '@foreman-code/contracts/files'
import { assertResponse } from '../../assertions.js'
import type { Scenario } from '../../scenario.js'
import { readCodecFixture } from '../codecs/fixtures.js'
import { conversationFilesPath, uploadConversationFile } from '../codecs/files.js'
import { createConversation } from '../smoke/conversations.js'
import { assertApiError, httpCoverage } from '../smoke/support.js'
import { cancelStagedFile } from './file-cancellation.js'
import { allocateFile, assertFileDownload, fileContentPath, fileListBody } from './file-support.js'
import { assertUploadRejections } from './file-upload-errors.js'
import { assertProtectedRead, readCoverage } from './support.js'

const root = '/api/operator/conversations/:conversationId/files'
const uploads = `${root}/uploads`
const upload = `${uploads}/:requestId`
const content = `${root}/:fileId/revisions/:revisionId/content`

export const conversationFilesScenario: Scenario = {
  id: 'http.files.operator-conversation',
  title: 'Conversation uploads preserve staging, byte integrity, ownership, and retained tombstones',
  lane: 'A2',
  covers: [
    ...readCoverage(root),
    ...readCoverage(content),
    ...(['success', 'error'] as const).flatMap(outcome => [
      httpCoverage('POST', uploads, outcome),
      httpCoverage('PUT', upload, outcome),
      httpCoverage('POST', `${upload}/finalize`, outcome),
      httpCoverage('DELETE', upload, outcome),
    ]),
  ],
  async run(ctx) {
    const { conversation } = await createConversation(ctx, 'Conformance conversation files')
    const path = conversationFilesPath(conversation.id)
    const fixture = await readCodecFixture('sample.png')
    const ready = await uploadConversationFile(ctx, conversation.id, fixture)
    await assertProtectedRead(ctx, path, fileListBody([ready.value]))
    await assertFileDownload(ctx, fileContentPath(path, ready.value), fixture)
    assertApiError(await ctx.http.request('DELETE', `${path}/uploads/${ready.requestId}`),
      409, 'FILE_ALREADY_FINALIZED', 'Only unsent staging can be canceled; finalized files cannot be deleted through this route.')
    assertApiError(await ctx.http.request('GET', `${path}/${ready.ref.fileId}/revisions/${randomUUID()}/content`),
      404, 'FILE_NOT_FOUND', 'The pinned file revision was not found in this scope.')
    assertApiError(await ctx.http.request('GET', `${path}?cursor=invalid-conformance-cursor`),
      400, 'FILE_CURSOR_INVALID', 'The cursor does not belong to this file list.')

    const { input, pending } = await allocateFile(ctx, path, fixture, ready.scope, DEFAULT_FILE_RETENTION_SECONDS)
    assertApiError(await ctx.http.request('POST', `${path}/uploads`, {
      body: { ...input, filename: 'renamed.png' },
    }), 409, 'FILE_REQUEST_CONFLICT', 'requestId was already used for different file metadata or a different scope.')
    await assertUploadRejections(ctx, path, input.requestId, pending, fixture)
    await assertProtectedRead(ctx, path, fileListBody([ready.value, pending]))
    assertResponse(await ctx.http.upload(`${path}/uploads/${input.requestId}`, fixture.bytes), {
      status: 200, body: { value: pending, replayed: false },
    })
    const canceled = await cancelStagedFile(ctx, path, input.requestId, pending, fixture)
    const records = fileListBody([ready.value, canceled])
    await assertProtectedRead(ctx, path, records)

    const conversationPath = `/api/operator/conversations/${conversation.id}`
    assertResponse(await ctx.http.request('DELETE', conversationPath), {
      status: 200, body: { conversationId: conversation.id, revision: 1 },
    })
    assertApiError(await ctx.http.request('GET', path),
      404, 'FILE_CONVERSATION_NOT_FOUND', 'The conversation was not found.')
    assertResponse(await ctx.http.request('HEAD', path), { status: 404, body: null })
    assertApiError(await ctx.http.request('GET', fileContentPath(path, ready.value)),
      404, 'FILE_CONVERSATION_NOT_FOUND', 'The conversation was not found.')
    assertResponse(await ctx.http.request('POST', `${conversationPath}/restore`), {
      status: 200, body: { conversationId: conversation.id, revision: 2 },
    })
    await assertProtectedRead(ctx, path, records)
    await ctx.target.restart()
    await assertProtectedRead(ctx, path, records)
    await assertFileDownload(ctx, fileContentPath(path, ready.value), fixture)
    assertApiError(await ctx.http.request('GET', fileContentPath(path, canceled)),
      410, 'FILE_BYTES_UNAVAILABLE', 'The pinned file bytes are no longer available.')
  },
}
