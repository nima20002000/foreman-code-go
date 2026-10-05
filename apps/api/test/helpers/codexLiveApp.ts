import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { DEFAULT_CODEX_ADVANCED_CONFIGURATION } from '@graphql/contracts'
import { buildApp } from '../../src/app.js'
import { applyApplicationMigrations } from '../../src/infrastructure/migrations.js'
import { PostgresAccessService } from '../../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../../src/modules/commands/postgres.js'
import { OperatorChatService } from '../../src/modules/conversations/operatorChat.js'
import { PostgresOperatorChatAuthority } from '../../src/modules/conversations/operatorChatAuthority.js'
import { PostgresOperatorConversationRepository } from '../../src/modules/conversations/operatorChatRepository.js'
import { CodexAppServerSessionManager } from '../../src/modules/harnesses/codexAppServer.js'
import { codexMcpInspectorAdapter } from '../../src/modules/harnesses/codexMcpInspectorAdapter.js'
import { NativeRollout } from '../../src/modules/harnesses/nativeRollout.js'
import { PostgresOperatorRepository } from '../../src/modules/operators/postgres.js'
import type { OperatorServices } from '../../src/mcp/operator/types.js'
import type { OperatorNativeSessionStart } from '../../src/modules/harnesses/port.js'

/** Real application authority and MCP routing; only the test's isolated database is disposable. */
export async function createCodexLiveApplication(binary: string, directory: string, signal: AbortSignal) {
  const server = new URL(process.env.ENG03_A_TEST_DATABASE_URL
    ?? 'postgresql://graphql:graphql@127.0.0.1:5432/graphql_test')
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(server.hostname)
    || !server.pathname.endsWith('_test')) throw new Error('Native acceptance requires a loopback test database.')
  server.pathname = '/postgres'
  const database = `graphql_codex_${randomUUID().replaceAll('-', '')}_test`
  const admin = new pg.Pool({ connectionString: server.toString(), max: 1 })
  try { await admin.query(`create database "${database}"`) } catch (error) {
    await admin.end()
    throw error
  }
  server.pathname = `/${database}`
  const pool = new pg.Pool({ connectionString: server.toString(), max: 2 })
  let app: ReturnType<typeof buildApp> | undefined
  let chat: OperatorChatService | undefined
  let authority: PostgresOperatorChatAuthority | undefined
  let conversationId: string | undefined
  const managers: CodexAppServerSessionManager[] = []
  async function close() {
    const failures: unknown[] = []
    const release = async (work: () => Promise<unknown>) => {
      try { await work() } catch (error) { failures.push(error) }
    }
    try {
      for (const manager of managers) await release(() => manager.shutdown())
      if (chat) await release(() => chat!.shutdown())
      if (conversationId && authority) await release(() => authority!.release(conversationId!))
      if (app) await release(() => app!.close())
    } finally {
      await release(() => pool.end())
      await release(() => admin.query(`drop database "${database}"`))
      await release(() => admin.end())
    }
    if (failures.length) throw new AggregateError(failures, 'Native application cleanup failed.')
  }
  try {
    await applyApplicationMigrations(pool)
    const access = new PostgresAccessService(pool)
    const owner = await access.issue({ name: 'Native lifecycle acceptance owner', audience: 'operator',
      grants: [{ actions: ['operator_chat:read', 'operator_chat:write', 'operator_chat:cancel',
        'operator_chat:respond', 'harnesses:read'], scope: {} }],
      expiresAt: new Date(Date.now() + 600_000) })
    const operators = new PostgresOperatorRepository(pool)
    const initial = await operators.ensure()
    const configured = await operators.update({ harness: 'codex', model: process.env.CODEX_MODEL ?? 'gpt-5.6-luna',
      reasoningEffort: 'low', sandbox: 'read-only', serviceTier: 'standard',
      advanced: structuredClone(DEFAULT_CODEX_ADVANCED_CONFIGURATION) }, initial.configuration.id)
    const services = { commands: new PostgresCommandCoordinator(pool) } as OperatorServices
    app = buildApp({ readiness: {
      database: { ping: async () => { await pool.query('select 1') } },
      checkpoints: { ping: async () => undefined },
    }, operator: { access, services } })
    const endpoint = `${await app.listen({ host: '127.0.0.1', port: 0 })}/mcp`
    const manager = new CodexAppServerSessionManager(binary, undefined, endpoint)
    const restored = new CodexAppServerSessionManager(binary, undefined, endpoint)
    managers.push(manager, restored)
    authority = new PostgresOperatorChatAuthority(pool, access,
      new NativeRollout({ ...process.env, HOST: '127.0.0.1' }), directory, endpoint,
      native => codexMcpInspectorAdapter(native as CodexAppServerSessionManager))
    chat = new OperatorChatService(new PostgresOperatorConversationRepository(pool), operators,
      () => manager, directory, authority)
    services.operatorChat = chat
    const conversation = await chat.create(owner.principal)
    conversationId = conversation.id
    const environment = await authority.prepare(manager, configured.configuration, conversation.id,
      owner.principal.id, signal)
    const input: OperatorNativeSessionStart = { kind: 'operator',
      configuration: configured.configuration, workingDirectory: directory,
      correlationId: `operator:${conversation.id}:native-lifecycle`, environment }
    return { manager, restored, input, close }
  } catch (error) {
    try { await close() } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Native application setup and cleanup failed.', { cause: cleanupError })
    }
    throw error
  }
}
