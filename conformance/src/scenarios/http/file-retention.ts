import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  DEFAULT_FILE_RETENTION_SECONDS,
  MIN_FILE_RETENTION_SECONDS,
  FileRetentionGetResultSchema,
  FileRetentionPreviewInputSchema,
  FileRetentionSaveInputSchema,
  FileWithRevisionSchema,
  temporaryFileExpiresAt,
  type FileRetentionPreference,
} from '@foreman-code/contracts/files'
import { assertResponse } from '../../assertions.js'
import type { Scenario, ScenarioContext } from '../../scenario.js'
import { readCodecFixture } from '../codecs/fixtures.js'
import { assertFileList, conversationFilesPath, downloadConversationFile, uploadConversationFile } from '../codecs/files.js'
import { createConversation } from '../smoke/conversations.js'
import { assertApiError, httpCoverage } from '../smoke/support.js'
import { allocateFile } from './file-support.js'
import { assertProtectedRead, readCoverage } from './support.js'

const retentionPath = '/api/management/file-retention'
const previewPath = `${retentionPath}/preview`

async function previewRetention(ctx: ScenarioContext, preference: FileRetentionPreference, durationSeconds: number) {
  const response = await ctx.http.request('POST', previewPath, {
    body: FileRetentionPreviewInputSchema.parse({ durationSeconds }),
  })
  assertResponse(response, { status: 200, body: {
    ownerPrincipalId: preference.ownerPrincipalId, preferenceRevision: preference.revision,
    durationSeconds, asOfUtc: '<timestamp>', expireNowCount: 0,
  } }, [{ pointer: '/body/asOfUtc', kind: 'timestamp' }])
}

export const fileRetentionScenario: Scenario = {
  id: 'http.files.retention',
  title: 'Retention changes a real uploaded file and preserves subsequent allocation snapshots',
  lane: 'A2',
  authentication: 'local-human',
  covers: [
    ...readCoverage(retentionPath),
    httpCoverage('POST', retentionPath, 'success'),
    httpCoverage('POST', retentionPath, 'error'),
    httpCoverage('POST', previewPath, 'success'),
    httpCoverage('POST', previewPath, 'error'),
  ],
  async run(ctx) {
    const { conversation } = await createConversation(ctx, 'Conformance file retention')
    const fixture = await readCodecFixture('sample.png')
    const uploaded = await uploadConversationFile(ctx, conversation.id, fixture)
    assert.ok(uploaded.scope.chat.kind === 'operator')
    const initial: FileRetentionPreference = {
      ownerPrincipalId: uploaded.scope.chat.ownerPrincipalId,
      durationSeconds: DEFAULT_FILE_RETENTION_SECONDS, revision: 0,
    }
    FileRetentionGetResultSchema.parse({ preference: initial })
    await assertProtectedRead(ctx, retentionPath, { preference: initial })
    await previewRetention(ctx, initial, MIN_FILE_RETENTION_SECONDS)
    assertApiError(await ctx.http.request('POST', previewPath, {
      token: 'conformance-invalid-credential',
      body: FileRetentionPreviewInputSchema.parse({ durationSeconds: MIN_FILE_RETENTION_SECONDS }),
    }), 401, 'AUTH_INVALID', 'The supplied credential is invalid.')

    const input = FileRetentionSaveInputSchema.parse({
      commandId: randomUUID(), expectedRevision: 0,
      durationSeconds: MIN_FILE_RETENTION_SECONDS, applyToExisting: true,
    })
    const preference: FileRetentionPreference = { ...initial, durationSeconds: MIN_FILE_RETENTION_SECONDS, revision: 1 }
    const value = { preference, updatedFileCount: 1, expiredNowCount: 0 }
    assertResponse(await ctx.http.request('POST', retentionPath, { body: input }), {
      status: 200, body: { value, replayed: false },
    })
    assertResponse(await ctx.http.request('POST', retentionPath, { body: input }), {
      status: 200, body: { value, replayed: true },
    })
    assertApiError(await ctx.http.request('POST', retentionPath, {
      body: { ...input, commandId: randomUUID(), durationSeconds: DEFAULT_FILE_RETENTION_SECONDS },
    }), 409, 'REVISION_CONFLICT', 'File retention changed. Read the current preference before saving.', {
      expectedRevision: 0, actualRevision: 1,
    })
    assertApiError(await ctx.http.request('POST', retentionPath, {
      body: { ...input, durationSeconds: DEFAULT_FILE_RETENTION_SECONDS },
    }), 409, 'COMMAND_ID_CONFLICT', 'This command ID was already used with different input.')

    const updatedFile = FileWithRevisionSchema.parse({ ...uploaded.value, file: {
      ...uploaded.value.file, retentionDurationSeconds: MIN_FILE_RETENTION_SECONDS,
      expiresAt: temporaryFileExpiresAt(uploaded.value.file.createdAt, MIN_FILE_RETENTION_SECONDS),
    } })
    await assertFileList(ctx, conversation.id, [updatedFile])
    assert.deepStrictEqual(await downloadConversationFile(ctx, conversation.id, updatedFile), fixture.bytes)
    await assertProtectedRead(ctx, retentionPath, { preference })
    await previewRetention(ctx, preference, MIN_FILE_RETENTION_SECONDS)

    const { conversation: laterConversation } = await createConversation(ctx, 'Conformance later allocation')
    const laterScope = { ...uploaded.scope, chat: { ...uploaded.scope.chat, conversationId: laterConversation.id } }
    const later = await allocateFile(ctx, conversationFilesPath(laterConversation.id), fixture, laterScope, MIN_FILE_RETENTION_SECONDS)
    const preserve = FileRetentionSaveInputSchema.parse({
      commandId: randomUUID(), expectedRevision: 1, durationSeconds: DEFAULT_FILE_RETENTION_SECONDS,
    })
    const restoredPreference: FileRetentionPreference = { ...initial, revision: 2 }
    const restored = { preference: restoredPreference, updatedFileCount: 0, expiredNowCount: 0 }
    assertResponse(await ctx.http.request('POST', retentionPath, { body: preserve }), {
      status: 200, body: { value: restored, replayed: false },
    })
    assertResponse(await ctx.http.request('POST', retentionPath, { body: { ...preserve, applyToExisting: false } }), {
      status: 200, body: { value: restored, replayed: true },
    })
    await assertFileList(ctx, conversation.id, [updatedFile])
    await assertFileList(ctx, laterConversation.id, [later.pending])
    await ctx.target.restart()
    await assertProtectedRead(ctx, retentionPath, { preference: restoredPreference })
    await assertFileList(ctx, conversation.id, [updatedFile])
    await assertFileList(ctx, laterConversation.id, [later.pending])
    assert.deepStrictEqual(await downloadConversationFile(ctx, conversation.id, updatedFile), fixture.bytes)
  },
}
