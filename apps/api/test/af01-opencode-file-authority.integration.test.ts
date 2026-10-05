import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentChatContext, SendAgentChatMessageRequest } from '@foreman-code/contracts/agent-chat'
import { MAX_FILE_BYTES, type FileWithRevision, type MessageAttachmentRef } from '@foreman-code/contracts/files'
import { ManagementActionSchema, type ManagementPrincipal } from '@foreman-code/contracts/management'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'

import { fileStorageMigration } from '../src/infrastructure/fileStorageMigration.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { agentChatCorrelation, agentChatKey, PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { PostgresFileConversationAuthorization } from '../src/modules/files/authorization.js'
import { PostgresFileRepository } from '../src/modules/files/postgres.js'
import { TemporaryFileService } from '../src/modules/files/service.js'
import { FileByteStorage } from '../src/modules/files/storage.js'
import { FileToolArtifacts } from '../src/modules/files/tools/artifacts.js'
import { FileToolSessions } from '../src/modules/files/tools/context.js'
import { fileToolsMigration } from '../src/modules/files/tools/migration.js'
import { PostgresFileToolRepository } from '../src/modules/files/tools/postgres.js'
import { AgentFileToolService } from '../src/modules/files/tools/service.js'
import { adoptOpenCodePublications, resolveOpenCodeFileAdmission } from '../src/modules/harnesses/opencodeFiles/postgres.js'
import { nativeMessageId } from '../src/modules/harnesses/opencodeProtocol.js'
import { agent3Database, postgresEnabled, seedAgent3 } from './helpers/wave25Agent3.js'
import { configuration as openCodeConfiguration } from './opencode-fixtures.js'

const pin = (value: FileWithRevision): MessageAttachmentRef => ({
  fileId: value.file.fileId, revisionId: value.revision.revisionId,
})

/** AF-01: real admissions, two live principals, PostgreSQL sessions/publications,
 * and real file bytes. Only native session/ACK evidence is supplied by the fixture;
 * the resolver, pin validation and all file operations are the production code. */
describe.skipIf(!postgresEnabled)('AF-01 OpenCode file authority follows the accepted sender', { timeout: 60_000 }, () => {
  let database: Awaited<ReturnType<typeof agent3Database>>, root: string
  let access: PostgresAccessService, conversations: PostgresAgentChatRepository
  let authorization: PostgresFileConversationAuthorization, files: TemporaryFileService
  let sessions: FileToolSessions, tools: AgentFileToolService

  beforeAll(async () => {
    database = await agent3Database()
    // Also usable with integration runners that register FIL migrations separately.
    for (const migration of [fileStorageMigration, fileToolsMigration]) {
      if ((await database.pool.query('select 1 from application_migrations where version=$1', [migration.version])).rowCount) continue
      const client = await database.pool.connect()
      try {
        await client.query('begin')
        await client.query(migration.sql)
        await client.query('insert into application_migrations(version) values($1)', [migration.version])
        await client.query('commit')
      } catch (error) { await client.query('rollback'); throw error }
      finally { client.release() }
    }
    root = await mkdtemp(join(homedir(), '.af01-files-'))
    access = new PostgresAccessService(database.pool)
    conversations = new PostgresAgentChatRepository(database.pool)
    authorization = new PostgresFileConversationAuthorization(database.pool)
    files = new TemporaryFileService(new PostgresFileRepository(database.pool),
      new FileByteStorage(join(root, 'bytes'), MAX_FILE_BYTES), authorization)
    const repository = new PostgresFileToolRepository(database.pool)
    sessions = new FileToolSessions(repository, (id) => access.currentOperator(id), authorization)
    tools = new AgentFileToolService(files, sessions, new FileToolArtifacts(repository, files.bytes, sessions), repository)
  })
  afterAll(async () => {
    try { if (root) await rm(root, { recursive: true, force: true }) }
    finally { await database?.close() }
  })

  async function fixture(mixedUploaders: boolean, options: { persistSender?: boolean; acknowledge?: boolean } = {}) {
    const directory = await mkdtemp(join(root, 'workspace-'))
    const source = makeCurrentWorkflowFixture(randomUUID().slice(0, 8), 'sequential')
    const seeded = await seedAgent3(database.pool, directory, { ...source,
      configurations: source.configurations.map((config) => ({ ...config, harness: openCodeConfiguration() })),
    }, { run: false })
    const node = seeded.version.definition.nodes[0]!
    const config = seeded.configurations.find((value) => value.agentId === node.agentId)!
    const context: AgentChatContext = { workspaceId: seeded.scope.workspaceId, workflowId: seeded.scope.workflowId,
      workflowNodeId: node.id, agentId: node.agentId }
    const issue = (name: string) => access.issue({ name, audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
      grants: [{ actions: [...ManagementActionSchema.options], scope: { workspaceIds: [context.workspaceId] } }] })
    const uploader = await issue('AF-01 uploader A'), sender = await issue('AF-01 sender B')
    const key = agentChatKey(context)
    const request = (id: string | null, attachments: MessageAttachmentRef[] = []): SendAgentChatMessageRequest => ({
      requestId: randomUUID(), content: attachments.length ? '' : 'establish conversation',
      context: { workflowId: context.workflowId, workflowNodeId: context.workflowNodeId, agentId: context.agentId },
      intent: 'next_turn', expectedConversationId: id, ...(attachments.length ? { attachments } : {}),
    })
    const initial = await conversations.admit({ key, context, request: request(null), delivery: 'queued',
      ownerPrincipalId: uploader.principal.id, create: { context, agentConfigurationVersionId: config.id,
        harness: 'opencode', origin: { kind: 'fresh' }, workingDirectory: directory, runtimeDirectory: directory } })
    const conversationId = initial.conversationId
    await conversations.cancelQueued(conversationId, initial.turn.requestId)
    const nativeSessionId = `ses_${randomUUID().replaceAll('-', '')}`
    await conversations.bindSession(conversationId, '1.18.31', nativeSessionId)
    const target = { kind: 'agent' as const, workspaceId: context.workspaceId, conversationId }
    async function upload(principal: ManagementPrincipal, text: string) {
      const data = Buffer.from(text), requestId = randomUUID()
      await files.allocate(principal, target, { requestId, filename: 'shared.md', mediaType: 'text/markdown',
        byteSize: data.length, sha256: createHash('sha256').update(data).digest('hex') })
      await files.upload(principal, target, requestId, Readable.from([data]))
      return (await files.finalize(principal, target, requestId)).value
    }
    const fromA = await upload(uploader.principal, '# uploaded by A\n')
    const attachments = [pin(fromA)]
    if (mixedUploaders) attachments.push(pin(await upload(sender.principal, '# uploaded by B\n')))
    const liveSender = await access.currentOperator(sender.principal.id)
    await authorization.resolve(liveSender, target, 'write')
    const input = request(conversationId, attachments)
    const accepted = await conversations.admit({ key, context, request: input, delivery: 'queued',
      ...(options.persistSender !== false ? { ownerPrincipalId: liveSender.id } : {}) })
    expect(await conversations.claim(conversationId, input.requestId)).toBe(true)
    const clientCorrelationId = agentChatCorrelation(conversationId, input.requestId)
    const nativeTurnId = nativeMessageId(clientCorrelationId)
    if (options.acknowledge !== false) {
      expect(await conversations.accepted(conversationId, input.requestId, nativeTurnId)).toBe(true)
    }
    const identity = { ownerAgentId: context.agentId, nativeSessionId, nativeTurnId,
      clientCorrelationId, directory, configuration: openCodeConfiguration() }
    return { conversationId, accepted, attachments, identity, uploader, sender, target,
      resolve: () => resolveOpenCodeFileAdmission(database.pool, conversationId, identity) }
  }

  async function messageRefs(messageId: string) {
    return (await database.pool.query<{ attachments: MessageAttachmentRef[]; publications: MessageAttachmentRef[] | null }>(
      `select record->'attachmentRefs' as attachments,record->'publicationRefs' as publications
       from operator_conversation_messages where id=$1`, [messageId])).rows[0]!
  }

  it.each([false, true])('binds the session to B and denies reads after B is revoked (mixed uploaders: %s)', async (mixed) => {
    const f = await fixture(mixed)
    const admission = await f.resolve()
    expect(admission).toBeDefined()
    const { context } = admission!
    expect(context).toMatchObject({ ownerPrincipalId: f.sender.principal.id, messageId: f.accepted.turn.messageId,
      nativeSessionId: f.identity.nativeSessionId, turnId: f.identity.nativeTurnId })
    expect(admission!.attachments).toEqual(f.attachments)
    const token = await sessions.issueForAcceptedSession(context, new Date(Date.now() + 60_000), 'opencode')
    expect((await sessions.authenticate(token)).principal.id).toBe(f.sender.principal.id)
    for (const ref of f.attachments) expect(await tools.read(token, ref)).toMatchObject({ status: 'ready', revision: ref })

    // A result is owned by the sender even when its source was uploaded by A.
    const copy = await tools.createWorkingCopy(token, { commandId: randomUUID(), source: f.attachments[0], destination: context.scope })
    const published = await tools.publish(token, { commandId: randomUUID(), artifactId: copy.value.artifactId,
      filename: 'result.md', mediaType: 'text/markdown', scope: context.scope })
    expect((await files.repository.read(published.value.file.fileId, published.value.revision.revisionId))?.ownerPrincipalId)
      .toBe(f.sender.principal.id)

    expect(await access.revoke(f.sender.principal.id)).toBe(true)
    await expect(tools.read(token, f.attachments[0])).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
    await expect(tools.list(token, { scope: context.scope })).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
    await expect(sessions.issueForAcceptedSession(context, new Date(Date.now() + 60_000), 'opencode'))
      .rejects.toMatchObject({ code: 'AUTH_REVOKED' })
    // The uploader is still authorized. Its continued access must not keep B's token alive.
    expect((await access.currentOperator(f.uploader.principal.id)).id).toBe(f.uploader.principal.id)
    const download = await files.download(await access.currentOperator(f.uploader.principal.id), f.target, f.attachments[0])
    download.stream.destroy()

    // Recovery adopts only B's durable publication, without reviving B's authority.
    await expect(adoptOpenCodePublications(database.pool, { ...context, ownerPrincipalId: f.uploader.principal.id }))
      .rejects.toMatchObject({ code: 'FILE_ADOPTION_MISMATCH' })
    await adoptOpenCodePublications(database.pool, context)
    const expected = { attachments: f.attachments, publications: [pin(published.value)] }
    expect(await messageRefs(f.accepted.turn.messageId)).toEqual(expected)
    await adoptOpenCodePublications(database.pool, context)
    expect(await messageRefs(f.accepted.turn.messageId)).toEqual(expected)
    await expect(tools.read(token, f.attachments[0])).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
  })

  it('keeps B authorized after A is revoked, including a mixed-uploader message', async () => {
    const f = await fixture(true)
    expect(await access.revoke(f.uploader.principal.id)).toBe(true)
    const admission = await f.resolve()
    expect(admission!.context.ownerPrincipalId).toBe(f.sender.principal.id)
    const token = await sessions.issueForAcceptedSession(admission!.context, new Date(Date.now() + 60_000), 'opencode')
    for (const ref of f.attachments) expect(await tools.read(token, ref)).toMatchObject({ status: 'ready', revision: ref })
    await sessions.revoke(token)
  })

  it('fails closed for an older attachment receipt without a persisted sender instead of inferring its uploader', async () => {
    const f = await fixture(false, { persistSender: false })
    await expect(f.resolve()).rejects.toMatchObject({ code: 'FILE_ADMISSION_OWNER_MISSING' })
  })

  it('validates preparation ownership before cleanup when no native acknowledgement or publication exists', async () => {
    const f = await fixture(false, { acknowledge: false })
    const admission = await f.resolve()
    expect(admission).toBeDefined()
    const context = admission!.context
    expect((await conversations.turn(f.conversationId, f.accepted.turn.requestId))?.nativeTurnId).toBeUndefined()
    await expect(adoptOpenCodePublications(database.pool, context)).resolves.toBeUndefined()
    await expect(adoptOpenCodePublications(database.pool, { ...context, ownerPrincipalId: f.uploader.principal.id }))
      .rejects.toMatchObject({ code: 'FILE_ADOPTION_MISMATCH' })
    await expect(adoptOpenCodePublications(database.pool, { ...context, turnId: nativeMessageId('foreign-turn') }))
      .rejects.toMatchObject({ code: 'FILE_ADOPTION_MISMATCH' })
    expect(await messageRefs(f.accepted.turn.messageId)).toEqual({ attachments: f.attachments, publications: null })
  })
})
