import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { AgentConfigurationVersionSchema } from '@foreman-code/contracts'
import { AgentChatStateSchema, type SendAgentChatMessageRequest } from '@foreman-code/contracts/agent-chat'
import { MAX_FILE_BYTES, MAX_MESSAGE_ATTACHMENTS } from '@foreman-code/contracts/files'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { AgentChatEvents, AgentChatService, type AgentChatManagerFactory } from '../src/modules/conversations/agentChat.js'
import { agentChatCorrelation, agentChatKey, PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { PostgresFileConversationAuthorization } from '../src/modules/files/authorization.js'
import { PostgresFileRepository } from '../src/modules/files/postgres.js'
import { TemporaryFileService } from '../src/modules/files/service.js'
import { FileByteStorage } from '../src/modules/files/storage.js'
import { FileToolArtifacts } from '../src/modules/files/tools/artifacts.js'
import { FileToolSessions } from '../src/modules/files/tools/context.js'
import type { FileMcpService } from '../src/modules/files/tools/mcp.js'
import { PostgresFileToolRepository } from '../src/modules/files/tools/postgres.js'
import { AgentFileToolService } from '../src/modules/files/tools/service.js'
import type { OpenCodeChatFiles } from '../src/modules/harnesses/opencodeFiles/chat.js'
import { cleanupOpenCodeDirectory, ownOpenCodeDirectory } from '../src/modules/harnesses/opencodeFiles/cleanup.js'
import { LocalOpenCodeExecutionFiles } from '../src/modules/harnesses/opencodeFiles/host.js'
import { adoptOpenCodePublications, resolveOpenCodeFileAdmission } from '../src/modules/harnesses/opencodeFiles/postgres.js'
import { nativeMessageId, object } from '../src/modules/harnesses/opencodeProtocol.js'
import { OpenCodeNativeSessionManager } from '../src/modules/harnesses/opencodeServer.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { agent3Database, deferred, postgresEnabled, seedAgent3 } from './helpers/wave25Agent3.js'
import { configuration, FixtureServer, json } from './opencode-fixtures.js'
import { waitForDelivery } from './helpers/agentChatDelivery.js'

it('retains current delivery listeners when an older subscription is released twice', () => {
  const events = new AgentChatEvents()
  const observed: Record<string, unknown>[] = []
  const releaseOld = events.subscribe('conversation', () => {})
  releaseOld()
  const releaseCurrent = events.subscribe('conversation', (event) => { observed.push(event.data) })
  releaseOld()
  events.publish('conversation', 'turn', { requestId: 'queued', delivery: 'accepted' })
  assert.deepEqual(observed, [{ requestId: 'queued', delivery: 'accepted' }])
  releaseCurrent()
})

// Native HTTP/SSE and its absent OS process are fixtures. Admission, credentials,
// bytes, host cleanup, manager, chat queue, HTTP/MCP authorization and SQL are real.
describe.skipIf(!postgresEnabled)('OpenCode file cleanup and persisted chat queue', { timeout: 60_000 }, () => {
  let database: Awaited<ReturnType<typeof agent3Database>>
  let vault: string
  beforeAll(async () => {
    database = await agent3Database()
    vault = await mkdtemp(join(homedir(), '.opencode-cleanup-files-'))
  })
  afterAll(async () => {
    try { if (vault) await rm(vault, { recursive: true, force: true }) }
    finally { await database?.close() }
  })

  for (const movedDirectory of [false, true]) {
    it(`commits native completion and runs the queued message with ${movedDirectory ? 'retryable disk failure' : 'sidecars and nested temp files'}`, async () => {
      const pool = database.pool
      const source = makeCurrentWorkflowFixture(randomUUID().slice(0, 8), 'single')
      source.configurations = source.configurations.map((value) => AgentConfigurationVersionSchema.parse({
        ...value, harness: configuration(),
      }))
      const saved = await seedAgent3(pool, database.directory, source, { run: false })
      const node = saved.version.definition.nodes[0]!
      const acceptedConfiguration = saved.configurations.find((value) => value.agentId === node.agentId)!
      const workspaceId = saved.scope.workspaceId
      const query = { workflowId: saved.scope.workflowId, workflowNodeId: node.id, agentId: node.agentId }
      const context = { workspaceId, ...query }
      const access = new PostgresAccessService(pool)
      const writer = await access.issue({ name: 'File cleanup writer', audience: 'operator',
        expiresAt: new Date(Date.now() + 600_000),
        grants: [{ actions: [...ManagementActionSchema.options], scope: { workspaceIds: [workspaceId] } }] })
      const reader = await access.issue({ name: 'File cleanup reader', audience: 'operator',
        expiresAt: new Date(Date.now() + 600_000),
        grants: [{ actions: ['agent_chat:read'], scope: { workspaceIds: [workspaceId] } }] })
      const conversations = new PostgresAgentChatRepository(pool)
      const request = (requestId: string, expectedConversationId: string | null): SendAgentChatMessageRequest => ({
        requestId, content: `File cleanup ${requestId}`, context: query, intent: 'next_turn', expectedConversationId,
      })
      const initial = await conversations.admit({ key: agentChatKey(context), context,
        request: request('initial', null), delivery: 'queued', ownerPrincipalId: writer.principal.id,
        create: { context, agentConfigurationVersionId: acceptedConfiguration.id, harness: 'opencode',
          origin: { kind: 'fresh' }, workingDirectory: database.directory, runtimeDirectory: database.directory } })
      const id = initial.conversationId
      await conversations.cancelQueued(id, 'initial')

      const authorization = new PostgresFileConversationAuthorization(pool)
      const bytes = new FileByteStorage(join(vault, randomUUID()), MAX_FILE_BYTES, [database.directory])
      const files = new TemporaryFileService(new PostgresFileRepository(pool), bytes, authorization)
      const fileRepository = new PostgresFileToolRepository(pool)
      const sessions = new FileToolSessions(fileRepository, (owner) => access.currentOperator(owner), authorization)
      const tools = new AgentFileToolService(files, sessions,
        new FileToolArtifacts(fileRepository, bytes, sessions), fileRepository)
      const target = { kind: 'agent' as const, workspaceId, conversationId: id }
      const data = Buffer.from('# original input\n')
      const uploadId = randomUUID()
      await files.allocate(writer.principal, target, { requestId: uploadId, filename: 'input.md',
        mediaType: 'text/markdown', byteSize: data.length, sha256: createHash('sha256').update(data).digest('hex') })
      await files.upload(writer.principal, target, uploadId, Readable.from([data]))
      const uploaded = (await files.finalize(writer.principal, target, uploadId)).value
      const attachment = { fileId: uploaded.file.fileId, revisionId: uploaded.revision.revisionId }

      const server = new FixtureServer()
      server.nextSessionIds.push(`ses_${randomUUID().replaceAll('-', '')}`)
      server.config = { mcp: { 'foreman-code': { enabled: false } } }
      server.mcp = { 'foreman-code': { status: 'disabled' } }
      server.beforeRequest = (path, init) => {
        if (new URL(path, 'http://fixture.invalid').pathname !== '/mcp' || init.method !== 'POST') return
        const body = object(JSON.parse(String(init.body)))
        server.mcp[String(body.name)] = { status: 'connected' }
        return json(server.mcp)
      }
      server.onPrompt = (sessionId, body) => {
        const partial = server.assistant(String(body.messageID), 'working', undefined, false, sessionId)
        server.emit('message.updated', { info: partial.info })
        for (const part of partial.parts) server.emit('message.part.updated', { part })
      }
      const roots = new Map<string, string>()
      const facades = new Map<string, FileMcpService>()
      const credentials = new Map<string, string>()
      const firstCredential = deferred()
      const scopedTools = {
        sessions: {
          async issueForAcceptedSession(binding: Parameters<FileToolSessions['issueForAcceptedSession']>[0], expiry: Date) {
            const token = await sessions.issueForAcceptedSession(binding, expiry, 'opencode')
            assert(binding.turnId)
            credentials.set(binding.turnId, token)
            firstCredential.resolve()
            return token
          },
          authenticate: sessions.authenticate.bind(sessions),
          authorizeAccepted: sessions.authorizeAccepted.bind(sessions),
          revoke: sessions.revoke.bind(sessions),
        },
        artifacts: tools.artifacts, list: tools.list.bind(tools), read: tools.read.bind(tools),
        createWorkingCopy: tools.createWorkingCopy.bind(tools), publish: tools.publish.bind(tools),
        publishedForTurn: tools.publishedForTurn.bind(tools),
      }
      const chatFiles: OpenCodeChatFiles = { async resolve(identity, signal) {
        signal.throwIfAborted()
        const admission = await resolveOpenCodeFileAdmission(pool, id, identity)
        assert(admission, 'The accepted Agent turn must have a file context.')
        const root = join(database.directory, randomUUID())
        const host = new LocalOpenCodeExecutionFiles({ executionHostId: 'fixture-native', root,
          maxFileBytes: MAX_FILE_BYTES, assertSourceIsolation: async () => undefined })
        roots.set(identity.nativeTurnId, root)
        return {
          admission: { ...admission, directory: identity.directory, executionHostId: host.executionHostId,
            mode: admission.context.allowMutation ? 'write' : 'read', expiresAt: new Date(Date.now() + 60_000) },
          options: { service: scopedTools, host, endpoint: 'http://127.0.0.1:9876/mcp/files',
            maxFileBytes: MAX_FILE_BYTES, maxAttachments: MAX_MESSAGE_ATTACHMENTS },
          read: (input) => tools.readAccepted(admission.context, input),
          adoptPublished: (binding) => adoptOpenCodePublications(pool, binding),
          async mount(facade) {
            await mkdir(root, { mode: 0o700 })
            const owned = await ownOpenCodeDirectory(root)
            facades.set(identity.nativeTurnId, facade)
            return async () => {
              facades.delete(identity.nativeTurnId)
              host.assertReleased()
              await cleanupOpenCodeDirectory(owned)
            }
          },
        }
      } }
      const manager = new OpenCodeNativeSessionManager({ server, ownerAgentId: node.agentId,
        appMcpServerName: 'foreman-code', appMcpAccess: 'none', chatFiles })
      const factory: AgentChatManagerFactory = () => manager
      const chat = new AgentChatService(pool, conversations, new PostgresOperatorConversationRepository(pool),
        new PostgresWorkflowRepository(pool), {
          getForWorkspace: async () => { throw new Error('This test does not read Runs.') },
          executionPages: () => { throw new Error('This test does not read executions.') },
        }, factory, database.directory)
      const operatorServices = {
        agentChat: chat,
        commands: new PostgresCommandCoordinator(pool),
      } as unknown as OperatorServices
      const app = buildApp({ readiness: { database: { ping: async () => undefined },
        checkpoints: { ping: async () => undefined } },
        operator: { access, services: operatorServices } })
      const clients: Client[] = []
      const firstId = nativeMessageId(agentChatCorrelation(id, 'A'))
      const secondId = nativeMessageId(agentChatCorrelation(id, 'B'))
      let moved: { original: string; held: string } | undefined
      try {
        const address = await app.listen({ host: '127.0.0.1', port: 0 })
        const connect = async (token: string) => {
          const client = new Client({ name: 'opencode-file-cleanup', version: '1' })
          clients.push(client)
          await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
            authProvider: { token: async () => token },
          }))
          return client
        }
        const writerMcp = await connect(writer.token)
        const readerMcp = await connect(reader.token)
        const first = { ...request('A', id), attachments: [attachment] }
        const response = await app.inject({ method: 'POST', url: `/api/workspaces/${workspaceId}/agent-chat/messages`,
          headers: { authorization: `Bearer ${writer.token}` }, payload: first })
        assert.equal(response.statusCode, 202, response.body)
        await waitForDelivery(chat, conversations, id, 'A', 'accepted')
        await firstCredential.promise
        const firstRoot = roots.get(firstId)!
        const directories = await readdir(firstRoot)
        const inputDirectory = join(firstRoot, directories[0]!)
        await writeFile(join(firstRoot, 'root-backup.md'), 'root editor backup')
        await mkdir(join(firstRoot, 'root-extraction', 'nested'), { recursive: true })
        await writeFile(join(firstRoot, 'root-extraction', 'nested', 'data'), 'root extraction')
        await writeFile(join(inputDirectory, 'input.md.bak'), 'editor backup')
        await mkdir(join(inputDirectory, 'extracted', 'nested'), { recursive: true })
        await writeFile(join(inputDirectory, 'extracted', 'nested', 'temp.md'), 'temporary bytes')
        if (movedDirectory) {
          moved = { original: inputDirectory, held: join(database.directory, randomUUID()) }
          await rename(moved.original, moved.held)
          await mkdir(moved.original)
          await writeFile(join(moved.original, 'foreign.md'), 'keep foreign replacement')
        }
        await assert.rejects(readerMcp.callTool({ name: 'agent_chat_send',
          arguments: { workspaceId, request: request('denied', id) } }), /not found/)
        assert.equal(await conversations.turn(id, 'denied'), undefined)
        const queued = await writerMcp.callTool({ name: 'agent_chat_send',
          arguments: { workspaceId, request: request('B', id) } })
        assert.notEqual(queued.isError, true)
        assert.equal((await conversations.turn(id, 'B'))?.delivery, 'queued')
        const nativeSessionId = (await conversations.get(id))!.native_session_id!
        server.complete(agentChatCorrelation(id, 'A'), 'Completed A', nativeSessionId)
        await waitForDelivery(chat, conversations, id, 'A', 'completed')
        await waitForDelivery(chat, conversations, id, 'B', 'accepted')
        const completed = await pool.query<{ result: unknown }>(
          'select result from operator_conversation_turns where conversation_id=$1 and request_id=$2', [id, 'A'])
        assert.deepEqual(completed.rows.map(row => row.result),
          [{ outcome: 'succeeded', output: { text: 'Completed A' } }])
        const token = credentials.get(firstId)!
        await assert.rejects(sessions.authenticate(token), { code: 'FILE_SESSION_EXPIRED' })
        assert.equal(facades.has(firstId), false)
        if (moved) {
          const replacement = await readFile(join(moved.original, 'foreign.md'), 'utf8')
          assert.equal(replacement, 'keep foreign replacement')
          await rm(moved.original, { recursive: true })
          await rename(moved.held, moved.original)
          moved = undefined
        } else {
          await assert.rejects(readdir(firstRoot), { code: 'ENOENT' })
        }
        server.complete(agentChatCorrelation(id, 'B'), 'Completed B', nativeSessionId)
        await waitForDelivery(chat, conversations, id, 'B', 'completed')
        const readback = await writerMcp.callTool({ name: 'agent_chat_read', arguments: { workspaceId, query } })
        const state = AgentChatStateSchema.parse(readback.structuredContent)
        assert.equal(state.activeTurn, null)
        for (const turnId of [firstId, secondId]) {
          assert.equal(server.calls.filter((call) => call.path.includes('/prompt_async')
            && call.body?.messageID === turnId).length, 1)
        }
        assert.equal(server.disposals, 0)
        assert.equal(server.calls.some((call) => call.path.includes('/abort')), false)
        await chat.shutdown()
        await assert.rejects(readdir(firstRoot), { code: 'ENOENT' })
      } finally {
        if (moved) {
          await rm(moved.original, { recursive: true })
          await rename(moved.held, moved.original)
        }
        await Promise.allSettled(clients.map((client) => client.close()))
        try { await app.close() }
        finally { try { await chat.shutdown() } finally { await manager.dispose() } }
      }
    })
  }
})
