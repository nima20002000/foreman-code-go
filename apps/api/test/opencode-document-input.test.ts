import assert from 'node:assert/strict'
import { it } from 'vitest'
import { AgentFileReadResultSchema, FILE_EXTENSIONS_BY_MEDIA_TYPE, FILE_MEDIA_TYPES,
  FileWithRevisionSchema, type FileMediaType, type FileWithRevision } from '@foreman-code/contracts/files'
import { readPinnedInput, sha256 } from '../src/modules/harnesses/opencodeFiles/attachments.js'
import type { OpenCodeAcceptedFileReader } from '../src/modules/harnesses/opencodeFiles/types.js'

const now = '2026-10-01T00:00:00.000Z'
const ref = { fileId: 'file-input', revisionId: 'revision-input' }
const bytes = Buffer.from('document bytes')
function document(mediaType: FileMediaType): FileWithRevision {
  return FileWithRevisionSchema.parse({
    file: { fileId: ref.fileId, currentRevisionId: ref.revisionId, createdAt: now, state: 'ready',
      scope: { kind: 'workspace_reference', workspaceId: 'workspace' } },
    revision: { ...ref, filename: `input.${FILE_EXTENSIONS_BY_MEDIA_TYPE[mediaType][0]}`, mediaType,
      byteSize: bytes.length, sha256: sha256(bytes), origin: 'upload', createdAt: now },
  })
}
function job(): FileWithRevision {
  return FileWithRevisionSchema.parse({
    file: { fileId: ref.fileId, currentRevisionId: ref.revisionId, createdAt: now, state: 'ready',
      scope: { kind: 'job_execution', workspaceId: 'workspace', jobExecutionId: 'job' },
      retentionDurationSeconds: 3600, expiresAt: '2026-10-01T01:00:00.000Z' },
    revision: { ...ref, byteClass: 'ci-output', filename: 'job.zip', mediaType: 'application/zip',
      byteSize: bytes.length, sha256: sha256(bytes), origin: 'job_output', createdAt: now },
  })
}
function range(value: FileWithRevision, offset: number) {
  const part = bytes.subarray(offset)
  return AgentFileReadResultSchema.parse({ status: 'ready', ...value, readAt: now, offset,
    byteLength: part.length, contentBase64: part.toString('base64'), eof: true })
}

for (const mediaType of FILE_MEDIA_TYPES) it(`retains document media ${mediaType} and final current-grant revalidation`, async () => {
  const calls: number[] = []
  const read: OpenCodeAcceptedFileReader = async (input) => {
    assert.equal(input.fileId, ref.fileId)
    assert.equal(input.revisionId, ref.revisionId)
    calls.push(input.offset)
    return range(document(mediaType), input.offset)
  }
  const result = await readPinnedInput(read, ref, 1024, new AbortController().signal)
  assert.equal(result.revision.mediaType, mediaType)
  assert.deepEqual(result.bytes, bytes)
  assert.deepEqual(calls, [0, bytes.length])
})

it('rejects a Job ZIP before decoding or native delivery despite matching document media', async () => {
  let calls = 0
  const read: OpenCodeAcceptedFileReader = async () => { calls++; return range(job(), 0) }
  await assert.rejects(readPinnedInput(read, ref, 1024, new AbortController().signal), /Only document revisions/)
  assert.equal(calls, 1)
})

it('rejects Job substitution at final grant revalidation without returning native bytes', async () => {
  const read: OpenCodeAcceptedFileReader = async (input) =>
    range(input.offset === 0 ? document('application/zip') : job(), input.offset)
  await assert.rejects(readPinnedInput(read, ref, 1024, new AbortController().signal), /Only document revisions/)
})
