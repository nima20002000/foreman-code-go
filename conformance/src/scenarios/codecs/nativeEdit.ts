import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  AgentFileApplyFormatEditInputSchema, AgentFileApplyFormatEditResultSchema,
  AgentFileCreateWorkingCopyInputSchema, AgentFileCreateWorkingCopyResultSchema,
  AgentFilePublishResultSchema, AgentFileReadInputSchema, AgentFileReadResultSchema,
  DEFAULT_FILE_RETENTION_SECONDS, FileDescriptionSchema, parseAgentFileReadResult,
  temporaryFileExpiresAt, type AgentFileFormatEdit,
} from '@foreman-code/contracts/files'
import { assertJson } from '../../assertions.js'
import type { ScenarioContext } from '../../scenario.js'
import { createConversation } from '../smoke/conversations.js'
import { sendOperatorTurn } from '../streams/operatorTurn.js'
import { installCodexScripts } from '../workflows/codexScript.js'
import { assertFileList, downloadConversationFile, uploadConversationFile } from './files.js'
import { bytesSha256, readCodecFixture, type CodecFixture, type CodecFixtureName } from './fixtures.js'

const EditAnswerSchema = z.object({
  read: AgentFileReadResultSchema,
  copy: AgentFileCreateWorkingCopyResultSchema,
  copyReplay: AgentFileCreateWorkingCopyResultSchema,
  edit: AgentFileApplyFormatEditResultSchema,
  published: AgentFilePublishResultSchema,
  publishReplay: AgentFilePublishResultSchema,
  resultRead: AgentFileReadResultSchema,
  sourceRead: AgentFileReadResultSchema,
}).strict()

interface CodecEditOptions {
  filename: CodecFixtureName
  outputFilename: string
  title: string
  edit: AgentFileFormatEdit
  verify(original: CodecFixture, output: Buffer, ctx: ScenarioContext): Promise<void>
}

function saved(name: string) { return { $ref: name } }

export async function editConversationFile(ctx: ScenarioContext, options: CodecEditOptions) {
  const original = await readCodecFixture(options.filename)
  const { conversation } = await createConversation(ctx, options.title)
  const uploaded = await uploadConversationFile(ctx, conversation.id, original)
  const readInput = AgentFileReadInputSchema.parse(uploaded.ref)
  const copyInput = AgentFileCreateWorkingCopyInputSchema.parse({
    commandId: randomUUID(), source: uploaded.ref, destination: uploaded.scope,
  })
  const edit = AgentFileApplyFormatEditInputSchema.shape.edit.parse(options.edit)
  const description = FileDescriptionSchema.parse({ filename: options.outputFilename, mediaType: original.mediaType })
  const publishInput = { commandId: randomUUID(), artifactId: saved('copy/value/artifactId'),
    scope: uploaded.scope, ...description }
  const resultReadInput = { fileId: saved('published/value/file/fileId'),
    revisionId: saved('published/value/revision/revisionId') }
  const names = ['read', 'copy', 'copyReplay', 'edit', 'published', 'publishReplay', 'resultRead', 'sourceRead']
  await installCodexScripts(ctx, [{ id: 'file-transformation', includes: options.title, turns: [{
    tools: [
      { name: 'files_read', arguments: readInput, saveAs: 'read' },
      { name: 'files_create_working_copy', arguments: copyInput, saveAs: 'copy' },
      { name: 'files_create_working_copy', arguments: copyInput, saveAs: 'copyReplay' },
      { name: 'files_apply_format_edit', arguments: { artifactId: saved('copy/value/artifactId'), edit }, saveAs: 'edit' },
      { name: 'files_publish_result', arguments: publishInput, saveAs: 'published' },
      { name: 'files_publish_result', arguments: publishInput, saveAs: 'publishReplay' },
      { name: 'files_read', arguments: resultReadInput, saveAs: 'resultRead' },
      { name: 'files_read', arguments: readInput, saveAs: 'sourceRead' },
    ],
    jsonAnswer: Object.fromEntries(names.map(name => [name, saved(name)])),
  }] }])
  return sendOperatorTurn(ctx, conversation, {
    content: options.title, attachments: [uploaded.ref], inputFiles: [uploaded.value],
    async assertAnswer(text) {
      const raw: unknown = JSON.parse(text)
      const answer = EditAnswerSchema.parse(raw)
      const publication = answer.published.value
      assert.notEqual(publication.file.fileId, uploaded.ref.fileId, 'An edit publishes a new file identity')
      assert.notEqual(publication.revision.revisionId, uploaded.ref.revisionId)
      const output = await downloadConversationFile(ctx, conversation.id, publication)
      assert.notDeepStrictEqual(output, original.bytes, 'This requested format edit must change the bytes')
      await options.verify(original, output, ctx)
      const content = { byteSize: output.byteLength, sha256: bytesSha256(output) }
      const originalRead = { status: 'ready', ...uploaded.value, readAt: '<timestamp>', offset: 0,
        byteLength: original.bytes.byteLength, contentBase64: original.bytes.toString('base64'), eof: true }
      parseAgentFileReadResult(readInput, answer.read)
      parseAgentFileReadResult(readInput, answer.sourceRead)
      parseAgentFileReadResult({ fileId: publication.file.fileId, revisionId: publication.revision.revisionId }, answer.resultRead)
      assertJson(raw, {
        read: originalRead,
        copy: { value: { artifactId: '<uuid>', source: uploaded.ref, destination: uploaded.scope,
          filename: original.filename, createdAt: '<timestamp>' }, replayed: false },
        copyReplay: { ...answer.copy, replayed: true },
        edit: { artifactId: answer.copy.value.artifactId, revisionId: '<uuid>', ...content },
        published: { value: {
          file: { fileId: '<uuid>', currentRevisionId: '<uuid>', scope: uploaded.scope, state: 'ready',
            createdAt: '<timestamp>', retentionDurationSeconds: DEFAULT_FILE_RETENTION_SECONDS,
            expiresAt: temporaryFileExpiresAt(publication.file.createdAt, DEFAULT_FILE_RETENTION_SECONDS) },
          revision: { fileId: publication.file.fileId, revisionId: publication.file.currentRevisionId,
            ...description, ...content, origin: 'agent_output', createdAt: publication.file.createdAt },
        }, replayed: false },
        publishReplay: { value: publication, replayed: true },
        resultRead: { status: 'ready', ...publication, readAt: '<timestamp>', offset: 0,
          byteLength: output.byteLength, contentBase64: output.toString('base64'), eof: true },
        sourceRead: originalRead,
      }, [
        { pointer: '/body/read/readAt', kind: 'timestamp' },
        { pointer: '/body/copy/value/artifactId', kind: 'uuid' },
        { pointer: '/body/copy/value/createdAt', kind: 'timestamp' },
        { pointer: '/body/edit/revisionId', kind: 'uuid' },
        { pointer: '/body/published/value/file/fileId', kind: 'uuid' },
        { pointer: '/body/published/value/file/currentRevisionId', kind: 'uuid' },
        { pointer: '/body/published/value/file/createdAt', kind: 'timestamp' },
        { pointer: '/body/resultRead/readAt', kind: 'timestamp' },
        { pointer: '/body/sourceRead/readAt', kind: 'timestamp' },
      ])
      assert.deepStrictEqual(await downloadConversationFile(ctx, conversation.id, uploaded.value), original.bytes)
      await assertFileList(ctx, conversation.id, [uploaded.value, publication])
      return [publication]
    },
    expectedToolCalls(text) {
      const answer = EditAnswerSchema.parse(JSON.parse(text))
      const artifactId = answer.copy.value.artifactId
      const additionalText = [`Working copy: ${JSON.stringify({ artifactId })}`]
      const publishArguments = { ...publishInput, artifactId }
      return [
        { name: 'files_read', arguments: readInput, result: answer.read },
        { name: 'files_create_working_copy', arguments: copyInput, result: answer.copy, additionalText },
        { name: 'files_create_working_copy', arguments: copyInput, result: answer.copyReplay, additionalText },
        { name: 'files_apply_format_edit', arguments: { artifactId, edit }, result: answer.edit },
        { name: 'files_publish_result', arguments: publishArguments, result: answer.published },
        { name: 'files_publish_result', arguments: publishArguments, result: answer.publishReplay },
        { name: 'files_read', arguments: { fileId: answer.published.value.file.fileId,
          revisionId: answer.published.value.revision.revisionId }, result: answer.resultRead },
        { name: 'files_read', arguments: readInput, result: answer.sourceRead },
      ]
    },
  })
}
