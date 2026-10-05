import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { MAX_FILE_BYTES } from '@graphql/contracts/files'
import { ManagementActionSchema } from '@graphql/contracts/management'
import type { NativeSessionReference, PendingNativeInteraction } from '@graphql/contracts'
import { buildApp } from '../src/app.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresLocalHumanAccess } from '../src/modules/access/localHuman.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { OperatorChatService, PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChat.js'
import { nativeCorrelation } from '../src/modules/conversations/operatorChatRepository.js'
import { PostgresFileConversationAuthorization } from '../src/modules/files/authorization.js'
import { PostgresFileRepository } from '../src/modules/files/postgres.js'
import { TemporaryFileService } from '../src/modules/files/service.js'
import { FileByteStorage } from '../src/modules/files/storage.js'
import type { NativeHarnessSessionManager, NativeHistory } from '../src/modules/harnesses/port.js'
import { unavailableNativeResponse } from '../src/modules/harnesses/responseAvailability.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { registerFileRoutes } from '../src/routes/files.js'
import { registerOperatorChatRoutes } from '../src/routes/operatorChat.js'
import { graphRpc } from './eng04-graph-composition-fixture.js'
import { browserOwnerUpgrade } from './helpers/browserOwnerUpgrade.js'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { fileFixtures, fileMetadata } from './helpers/fileFixtures.js'
import { privateFixtureDirectory } from './helpers/privateFixtureDirectory.js'

describe.skipIf(!postgresEnabled)('local human conversation recovery', { timeout: 60_000 }, () => {
  it('retains history, attachments and pending native response/cancel access after upgrade and restart', async () => {
    const db = await currentDatabase()
    const directory = await privateFixtureDirectory('local-human-chat-files-')
    const access = new PostgresAccessService(db.pool)
    const owner = await access.issue({ name: 'Former browser owner', audience: 'operator',
      grants: [{ actions: ManagementActionSchema.options, scope: {} }],
      expiresAt: new Date(Date.now() + 600_000) })
    const reader = await access.issue({ name: 'Unrelated MCP reader', audience: 'operator',
      grants: [{ actions: ['operator_chat:read'], scope: {} }], expiresAt: new Date(Date.now() + 600_000) })
    const repository = new PostgresOperatorConversationRepository(db.pool)
    const operators = new PostgresOperatorRepository(db.pool)
    const histories = new Map<string, NativeHistory>()
    const counts = { creates: 0, starts: 0, responses: 0, cancels: 0, attaches: 0 }
    const manager: NativeHarnessSessionManager = {
      harness: 'codex',
      capabilities() { throw new Error('Recovery does not query model capabilities.') },
      inspectMcp() { throw new Error('Recovery does not inspect launch configuration.') },
      createSession: async () => { counts.creates++; throw new Error('Recovery must retain the original session.') },
      startTurn() { counts.starts++; throw new Error('Recovery must retain the original turn.') },
      attachSession: async session => { counts.attaches++; return session },
      pending: async session => histories.get(session.nativeSessionId)?.pendingInteractions[0],
      history: async session => histories.get(session.nativeSessionId)!,
      reconcile: async session => histories.get(session.nativeSessionId)!,
      inspectResponseAvailability: async (session, query) => {
        const pending = histories.get(session.nativeSessionId)?.pendingInteractions
          .find(value => value.turn.nativeRequestId === query.nativeRequestId)
        if (!pending) return unavailableNativeResponse(session, query, 'request_consumed')
        return { nativeSessionId: session.nativeSessionId, nativeRequestId: query.nativeRequestId,
          nativeRequestType: query.nativeRequestType, nativeTurnId: pending.turn.nativeTurnId!,
          generation: `original:${session.nativeSessionId}`, qualified: true,
          state: 'available', path: 'qualified_recovery', reason: 'qualified_recovery' }
      },
      respond: async session => {
        counts.responses++
        const history = histories.get(session.nativeSessionId)!
        history.pendingInteractions = []
        history.terminalResult = { outcome: 'succeeded', output: { text: 'Approved original turn' } }
      },
      cancel: async session => {
        counts.cancels++
        const history = histories.get(session.nativeSessionId)!
        history.pendingInteractions = []
        history.terminalResult = { outcome: 'canceled' }
        return true
      },
      close: async () => {},
    }
    const authority = { current: (id: string) => access.currentOperator(id), assertConfiguration() {},
      setup: async () => ({ harness: 'codex' as const, status: 'configured' as const,
        endpoint: 'http://127.0.0.1/mcp', checkedAt: new Date().toISOString() }),
      prepare: async () => { throw new Error('Recovery must not issue launch authority.') }, release: async () => {} }
    let chat = new OperatorChatService(repository, operators, () => manager, db.directory, authority)
    let app: ReturnType<typeof buildApp> | undefined
    const files = () => new TemporaryFileService(new PostgresFileRepository(db.pool),
      new FileByteStorage(directory, MAX_FILE_BYTES), new PostgresFileConversationAuthorization(db.pool))
    try {
      const historyConversation = await chat.create(owner.principal, 'Original history')
      const attachment = fileFixtures.find(value => value.mediaType === 'text/markdown')!
      const uploadId = randomUUID()
      const target = { kind: 'operator' as const, conversationId: historyConversation.id }
      const storage = files()
      const allocated = await storage.allocate(owner.principal, target, { requestId: uploadId, ...fileMetadata(attachment) })
      await storage.upload(owner.principal, target, uploadId, Readable.from(attachment.bytes))
      await storage.finalize(owner.principal, target, uploadId)
      const pins = { fileId: allocated.value.file.fileId, revisionId: allocated.value.revision.revisionId }
      await repository.beginTurn(historyConversation.id, { requestId: 'original-history',
        content: 'Original attached message', attachments: [pins] }, owner.principal.id)
      await repository.finish(historyConversation.id, 'original-history',
        { outcome: 'succeeded', output: { text: 'Original answer' } }, 'original-answer')
      const history = await chat.history(historyConversation.id, owner.principal)
      const pending: Array<{ id: string; requestId: string; interaction: PendingNativeInteraction }> = []
      for (const name of ['respond', 'cancel']) {
        const conversation = await chat.create(owner.principal, `Original ${name}`)
        const requestId = `original-${name}`
        const nativeTurnId = `original-turn-${name}`
        const session: NativeSessionReference = { harness: 'codex', providerVersion: '0.154.0',
          nativeSessionId: `original-session-${name}` }
        const interaction: PendingNativeInteraction = { session,
          turn: { nativeTurnId, nativeRequestId: `original-approval-${name}` },
          nativeRequestType: 'item/commandExecution/requestApproval', request: { command: ['pwd'] },
          responseOptions: [{ optionId: 'once', label: 'Approve once', semantic: 'approve_once',
            persistence: 'request', affectsOtherPendingRequests: false, interruptsCurrentTurn: false,
            mutatesPersistentPolicy: false }] }
        await repository.beginTurn(conversation.id, { requestId, content: 'Original pending message' }, owner.principal.id)
        await repository.bind(conversation.id, requestId, session.providerVersion, session.nativeSessionId)
        await repository.submitted(conversation.id, requestId, nativeTurnId,
          { nativeSessionId: session.nativeSessionId, principalId: owner.principal.id })
        await repository.pending(conversation.id, requestId, interaction)
        histories.set(session.nativeSessionId, { correlationId: nativeCorrelation(conversation.id, requestId),
          nativeTurnId, events: [], pendingInteractions: [interaction] })
        pending.push({ id: conversation.id, requestId, interaction })
      }
      const originalOwners = (await db.pool.query('select id,owner_principal_id from operator_conversations order by id')).rows
      await browserOwnerUpgrade(db.pool, owner.principal.id)
      await chat.shutdown()
      await applyApplicationMigrations(db.pool)
      const human = new PostgresLocalHumanAccess(db.pool, new PostgresAccessService(db.pool))
      chat = new OperatorChatService(new PostgresOperatorConversationRepository(db.pool),
        new PostgresOperatorRepository(db.pool), () => manager, db.directory, authority)
      app = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
        operator: { access, services: { operatorChat: chat, commands: new PostgresCommandCoordinator(db.pool) } as never },
        localHuman: human })
      registerOperatorChatRoutes(app, chat)
      registerFileRoutes(app, files())
      await chat.reconcileActive()
      const list = await app.inject({ url: '/api/operator/conversations' })
      expect(list.statusCode, list.body).toBe(200)
      expect(list.json().conversations.map((value: { id: string }) => value.id).sort())
        .toEqual([historyConversation.id, ...pending.map(value => value.id)].sort())
      expect(await chat.history(historyConversation.id, await human.current())).toEqual(history)
      const download = await app.inject({
        url: `/api/operator/conversations/${historyConversation.id}/files/${pins.fileId}/revisions/${pins.revisionId}/content`,
      })
      expect(download.statusCode, download.body).toBe(200)
      expect(download.rawPayload).toEqual(attachment.bytes)
      const offered = pending[0]!
      const recovered = await chat.get(offered.id, await human.current())
      expect(recovered.pendingInteraction).toEqual(offered.interaction)
      expect(recovered.responseAvailability?.available).toBe(true)
      const respond = await app.inject({ method: 'POST', url: `/api/operator/conversations/${offered.id}/responses`,
        payload: { requestId: offered.requestId, nativeRequestId: offered.interaction.turn.nativeRequestId,
          optionId: 'once', commandId: randomUUID() } })
      expect(respond.statusCode, respond.body).toBe(200)
      const canceled = pending[1]!
      const cancel = await app.inject({ method: 'POST', url: `/api/operator/conversations/${canceled.id}/cancel`,
        payload: { requestId: canceled.requestId, commandId: randomUUID() } })
      expect(cancel.statusCode, cancel.body).toBe(200)
      expect((await chat.get(canceled.id, await human.current())).lastResult?.outcome).toBe('canceled')
      expect(counts).toEqual({ creates: 0, starts: 0, responses: 1, cancels: 1, attaches: 2 })
      const denied = await graphRpc(app, reader.token, 'tools/call',
        { name: 'operator_chat_get', arguments: { conversationId: historyConversation.id } })
      expect(denied.result?.isError).toBe(true)
      expect(await access.authenticate(reader.token)).toEqual(reader.principal)
      expect(await access.authenticate(owner.token)).toEqual(owner.principal)
      expect((await db.pool.query('select id,owner_principal_id from operator_conversations order by id')).rows)
        .toEqual(originalOwners)
    } finally {
      await app?.close()
      await chat.shutdown()
      await db.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
