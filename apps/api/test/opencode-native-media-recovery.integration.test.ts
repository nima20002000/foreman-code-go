import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import pg from 'pg'
import sharp from 'sharp'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { it } from 'vitest'
import { AgentChatStateSchema } from '@foreman-code/contracts/agent-chat'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { AgentChatService } from '../src/modules/conversations/agentChat.js'
import { agentChatCorrelation, PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { registerProductionFileStorage } from '../src/modules/files/production.js'
import { productionOpenCodeChatFiles } from '../src/modules/harnesses/opencodeFiles/production.js'
import { OPENCODE_HTTP_BODY_LIMIT } from '../src/modules/harnesses/opencodeClient.js'
import { nativeMessageId, object } from '../src/modules/harnesses/opencodeProtocol.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { eventually } from './helpers/agentChatF5.js'
import { agent3Database, deferred, seedAgent3 } from './helpers/wave25Agent3.js'
import { nativeConfigurationFixture } from './support/opencodeNativeConfiguration.js'

it('recovers accepted media from native disk in a fresh API and manager, then delivers queued MCP input once', async () => {
  const emitFirst = deferred()
  const finishFirst = deferred()
  const f = await nativeConfigurationFixture({ files: true,
    respond: async (_call, index) => {
      if (index === 2) { await emitFirst.promise; return 'Recovered first' }
      return index === 1 ? 'Completed.' : 'Completed next'
    },
    beforeFinish: async (_call, index) => { if (index === 2) await finishFirst.promise },
  })
  const database = await agent3Database()
  const { pool } = database
  const clients: Client[] = []
  const allocations: ReturnType<typeof f.allocateChat>[] = []
  const config = loadConfig({ DATABASE_URL: pool.options.connectionString,
    FILE_STORAGE_ROOT: f.vault, HARNESS_WORKSPACE_ROOT: f.workspaceRoot })
  const repository = new PostgresAgentChatRepository(pool)
  const access = new PostgresAccessService(pool)
  let service: AgentChatService | undefined
  let app: ReturnType<typeof buildApp> | undefined
  let lock: pg.PoolClient | undefined
  let shutdown: Promise<void> | undefined
  try {
    const source = makeCurrentWorkflowFixture(randomUUID(), 'single')
    for (const configuration of source.configurations) configuration.harness = f.harness
    const fixture = await seedAgent3(pool, f.workspaceRoot, source, { run: false })
    const workspaceId = fixture.scope.workspaceId
    const node = fixture.version.definition.nodes[0]!
    const query = { workflowId: fixture.scope.workflowId, workflowNodeId: node.id, agentId: node.agentId }
    const writer = await access.issue({ name: 'Native media writer', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000),
      grants: [{ actions: [...ManagementActionSchema.options], scope: { workspaceIds: [workspaceId] } }] })
    const reader = await access.issue({ name: 'Native media reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ['agent_chat:read'], scope: { workspaceIds: [workspaceId] } }] })
    const openApi = async () => {
      service = new AgentChatService(pool, new PostgresAgentChatRepository(pool),
        new PostgresOperatorConversationRepository(pool), new PostgresWorkflowRepository(pool),
        { getForWorkspace: async () => { throw new Error('No Run is used') }, async *executionPages() { yield [] } },
        (conversationId, configuration, workingDirectory) => {
          const allocation = f.allocateChat(workingDirectory, configuration.agentId,
            native => productionOpenCodeChatFiles(() => app!, pool, config, conversationId, native, '127.0.0.1'))
          allocations.push(allocation)
          return allocation.native
        }, f.workspaceRoot)
      app = buildApp({ readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
        operator: { access, services: { agentChat: service, commands: new PostgresCommandCoordinator(pool) } as unknown as OperatorServices } })
      const files = registerProductionFileStorage(app, pool, config)
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      const port = app.server.address()
      assert(port && typeof port !== 'string')
      config.port = port.port
      const connect = async (token: string) => {
        const client = new Client({ name: 'native-media-recovery', version: '1' })
        clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
          authProvider: { token: async () => token },
        }))
        return client
      }
      return { files, mcp: await connect(writer.token), denied: await connect(reader.token) }
    }
    const original = await openApi()
    const send = async (client: Client, requestId: string, expectedConversationId: string | null,
      attachments: { fileId: string; revisionId: string }[] = []) => {
      const result = await client.callTool({ name: 'agent_chat_send', arguments: { workspaceId,
        request: { requestId, context: query, content: requestId, intent: 'next_turn', expectedConversationId, attachments },
      } })
      assert.notEqual(result.isError, true, JSON.stringify(result))
      return (result.structuredContent as { state: { conversation: { id: string } } }).state.conversation.id
    }
    const id = await send(original.mcp, 'establish', null)
    try {
      await eventually(async () => (await repository.turn(id, 'establish'))?.delivery === 'completed')
    } catch (cause) {
      const turn = await repository.turn(id, 'establish')
      const conversation = await repository.get(id)
      throw new Error('Initial native chat did not complete: ' + JSON.stringify({
        turn,
        state: conversation?.turn_state,
        error: conversation?.last_error,
        modelCalls: f.calls.length,
      }), { cause })
    }
    const bytes = await sharp(randomBytes(1024 * 1024 * 3), {
      raw: { width: 1024, height: 1024, channels: 3 },
    }).png({ compressionLevel: 0 }).toBuffer()
    const hash = createHash('sha256').update(bytes).digest('hex')
    const target = { kind: 'agent' as const, workspaceId, conversationId: id }
    const attachments: { fileId: string; revisionId: string }[] = []
    for (let index = 0; index < 2; index += 1) {
      const requestId = randomUUID()
      await original.files.allocate(writer.principal, target, { requestId, filename: `image-${index}.png`,
        mediaType: 'image/png', byteSize: bytes.length, sha256: hash })
      await original.files.upload(writer.principal, target, requestId, Readable.from([bytes]))
      const file = (await original.files.finalize(writer.principal, target, requestId)).value
      attachments.push({ fileId: file.file.fileId, revisionId: file.revision.revisionId })
    }
    await send(original.mcp, 'first', id, attachments)
    const firstId = nativeMessageId(agentChatCorrelation(id, 'first'))
    await eventually(async () => (await repository.get(id))?.active_native_turn_id === firstId && f.calls.length === 2)
    await send(original.mcp, 'next', id)
    assert.equal((await repository.turn(id, 'next'))?.delivery, 'queued')
    assert.equal((await original.denied.listTools()).tools.some(tool => tool.name === 'agent_chat_send'), false)
    await assert.rejects(send(original.denied, 'denied', id), /not found/i)
    assert.equal(await repository.turn(id, 'denied'), undefined)
    const row = (await repository.get(id))!
    const server = allocations[0]!.server
    const originalPid = server.nativePid
    assert(originalPid)
    const nativePath = `/session/${row.native_session_id}/message/${firstId}?directory=${encodeURIComponent(row.record.workingDirectory)}`
    const storedResponse = await server.request(nativePath)
    const storedText = await storedResponse.text()
    assert(Buffer.byteLength(storedText) > OPENCODE_HTTP_BODY_LIMIT)
    const stored = JSON.parse(storedText) as { parts: { type: string; url?: string }[] }
    const images = stored.parts.filter(part => part.type === 'file' && part.url?.startsWith('data:image/png;base64,'))
    assert.equal(images.length, 2)
    for (const image of images) {
      assert.equal(createHash('sha256').update(Buffer.from(image.url!.split(',')[1]!, 'base64')).digest('hex'), hash)
    }

    // Hold API event commits while native storage finishes. Shutdown detaches the observer before its result can commit.
    lock = await pool.connect()
    await lock.query('begin')
    const lockPid = (await lock.query('select pg_backend_pid() as pid')).rows[0].pid as number
    await lock.query('select id from operator_conversations where id=$1 for update', [id])
    emitFirst.resolve()
    await eventually(async () => (await pool.query<{ blocked: boolean }>(
      'select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) as blocked', [lockPid])).rows[0]!.blocked)
    finishFirst.resolve()
    await eventually(async () => {
      const response = await server.request(`/session/${row.native_session_id}/message?limit=8`
        + `&directory=${encodeURIComponent(row.record.workingDirectory)}`)
      const messages = await response.json() as { info: Record<string, unknown> }[]
      return messages.some(message => message.info.parentID === firstId && message.info.finish === 'stop'
        && typeof object(message.info.time).completed === 'number')
    })
    shutdown = service!.shutdown()
    await lock.query('commit')
    lock.release()
    lock = undefined
    await shutdown
    shutdown = undefined
    assert.notEqual((await repository.turn(id, 'first'))?.delivery, 'completed')
    assert.equal((await repository.turn(id, 'next'))?.delivery, 'queued')
    await Promise.all(clients.splice(0).map(client => client.close()))
    await app!.close()
    const restarted = await openApi()
    await service!.recover()
    await eventually(async () => (await repository.turn(id, 'first'))?.delivery === 'completed'
      && (await repository.turn(id, 'next'))?.delivery === 'completed')
    assert.equal(allocations.length, 2)
    assert.notEqual(allocations[0]!.native, allocations[1]!.native)
    assert.notEqual(originalPid, allocations[1]!.server.nativePid)
    assert.equal((await repository.get(id))?.native_session_id, row.native_session_id)
    const read = await restarted.mcp.callTool({ name: 'agent_chat_read', arguments: { workspaceId, query } })
    assert.notEqual(read.isError, true, JSON.stringify(read))
    const state = AgentChatStateSchema.parse(read.structuredContent)
    assert.equal(state.activeTurn, null)
    assert(state.messages.some(message => message.content === 'Recovered first'))
    assert(state.messages.some(message => message.content === 'Completed next'))
    const persisted = await pool.query<{ request_id: string; result: unknown }>(
      'select request_id,result from operator_conversation_turns where conversation_id=$1 order by turn_sequence', [id])
    assert.deepEqual(persisted.rows.slice(1), [
      { request_id: 'first', result: { outcome: 'succeeded', output: { text: 'Recovered first' } } },
      { request_id: 'next', result: { outcome: 'succeeded', output: { text: 'Completed next' } } },
    ])
    const afterRestart = await allocations[1]!.server.request(nativePath)
    assert.deepEqual((await afterRestart.json() as { parts: unknown[] }).parts, stored.parts)
    assert.equal(f.calls.length, 3)
    const all = await allocations[1]!.server.request(`/session/${row.native_session_id}/message`
      + `?directory=${encodeURIComponent(row.record.workingDirectory)}`)
    const history = await all.json() as { info: { id: string } }[]
    for (const requestId of ['first', 'next']) {
      const expected = nativeMessageId(agentChatCorrelation(id, requestId))
      assert.equal(history.filter(message => message.info.id === expected).length, 1)
      assert.equal(state.turns.find(turn => turn.requestId === requestId)?.nativeTurnId, expected)
    }
  } finally {
    emitFirst.resolve()
    finishFirst.resolve()
    if (lock) { await lock.query('rollback'); lock.release() }
    await shutdown
    await service?.shutdown()
    await Promise.allSettled(clients.map(client => client.close()))
    await app?.close()
    await f.close()
    await database.close()
  }
}, 120_000)
