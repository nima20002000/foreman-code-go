import { randomUUID } from 'node:crypto'
import { chmod, copyFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { DEFAULT_CODEX_ADVANCED_CONFIGURATION } from '@foreman-code/contracts'
import { buildApp } from '../../src/app.js'
import { applyApplicationMigrations } from '../../src/infrastructure/migrations.js'
import { PostgresAccessService } from '../../src/modules/access/postgres.js'
import { PostgresLocalHumanAccess } from '../../src/modules/access/localHuman.js'
import { PostgresCommandCoordinator } from '../../src/modules/commands/postgres.js'
import { OperatorChatService } from '../../src/modules/conversations/operatorChat.js'
import { PostgresOperatorChatAuthority } from '../../src/modules/conversations/operatorChatAuthority.js'
import { PostgresOperatorConversationRepository } from '../../src/modules/conversations/operatorChatRepository.js'
import { CodexAppServerSessionManager } from '../../src/modules/harnesses/codexAppServer.js'
import { CodexMcpConnections } from '../../src/modules/harnesses/codexMcpConnections.js'

import { HarnessMcpSettingsService } from '../../src/modules/harnesses/mcpSettings.js'
import { codexMcpInspectorAdapter } from '../../src/modules/harnesses/codexMcpInspectorAdapter.js'
import { NativeRollout } from '../../src/modules/harnesses/nativeRollout.js'
import { PostgresOperatorRepository } from '../../src/modules/operators/postgres.js'
import type { OperatorServices } from '../../src/mcp/operator/types.js'
import type { OperatorNativeSessionStart } from '../../src/modules/harnesses/port.js'
import { privateFixtureDirectory } from './privateFixtureDirectory.js'

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
  let settings: HarnessMcpSettingsService | undefined
  let profile: string | undefined
  const originalProfile = process.env.CODEX_HOME
  const managers: CodexAppServerSessionManager[] = []
  async function close() {
    const failures: unknown[] = []
    const release = async (work: () => Promise<unknown>) => {
      try { await work() } catch (error) { failures.push(error) }
    }
    try {
      for (const manager of managers) await release(() => manager.shutdown())
      if (settings) await release(() => settings!.shutdown())
      if (chat) await release(() => chat!.shutdown())
      if (conversationId && authority) await release(() => authority!.release(conversationId!))
      if (app) await release(() => app!.close())
    } finally {
      await release(() => pool.end())
      await release(() => admin.query(`drop database "${database}"`))
      await release(() => admin.end())
      if (originalProfile === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = originalProfile
      if (profile) await release(() => rm(profile!, { recursive: true, force: true }))
    }
    if (failures.length) throw new AggregateError(failures, 'Native application cleanup failed.')
  }
  try {
    await applyApplicationMigrations(pool)
    profile = await privateFixtureDirectory('codex-native-profile-')
    await writeFile(join(profile, 'config.toml'), '', { mode: 0o600, flag: 'wx' })
    try {
      await copyFile(join(originalProfile ?? join(homedir(), '.codex'), 'auth.json'), join(profile, 'auth.json'))
      await chmod(join(profile, 'auth.json'), 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    process.env.CODEX_HOME = profile
    const access = new PostgresAccessService(pool)
    const localHuman = new PostgresLocalHumanAccess(pool, access)
    const owner = await localHuman.current()
    const operators = new PostgresOperatorRepository(pool)
    const initial = await operators.ensure()
    const configured = await operators.update({ harness: 'codex', model: process.env.CODEX_MODEL ?? 'gpt-5.6-luna',
      reasoningEffort: 'medium', sandbox: 'read-only', serviceTier: 'standard',
      advanced: structuredClone(DEFAULT_CODEX_ADVANCED_CONFIGURATION) }, initial.configuration.id)
    const services = { commands: new PostgresCommandCoordinator(pool) } as OperatorServices
    app = buildApp({ readiness: {
      database: { ping: async () => { await pool.query('select 1') } },
      checkpoints: { ping: async () => undefined },
    }, localHuman, operator: { access, services } })
    const endpoint = `${await app.listen({ host: '127.0.0.1', port: 0 })}/mcp`
    settings = new HarnessMcpSettingsService(pool, services.commands, { codex: new CodexMcpConnections(binary, directory) }, () => {}, async () => {}, endpoint)
    const before = await settings.list(owner, 'codex')
    const installed = await settings.applyManaged(owner, { harness: 'codex', preset: 'graphql',
      installed: true, expectedRevision: before.revision, commandId: randomUUID() })
    if (installed.status !== 'applied') throw new Error(installed.error ?? 'Native App MCP installation did not settle.')
    const configuredMcp = await settings.list(owner, 'codex')
    if (configuredMcp.presets?.graphql === 'disabled') {
      const enabled = await settings.applyManaged(owner, { harness: 'codex', preset: 'graphql',
        enabled: true, expectedRevision: configuredMcp.revision, commandId: randomUUID() })
      if (enabled.status !== 'applied') throw new Error(enabled.error ?? 'Native App MCP enabling did not settle.')
    }
    if ((await settings.list(owner, 'codex')).presets?.graphql !== 'installed') {
      throw new Error('The managed native App MCP connection is not installed and enabled.')
    }
    const manager = new CodexAppServerSessionManager(binary)
    const restored = new CodexAppServerSessionManager(binary)
    managers.push(manager, restored)
    authority = new PostgresOperatorChatAuthority(pool, access,
      new NativeRollout({ ...process.env, HOST: '127.0.0.1' }), directory, endpoint,
      native => codexMcpInspectorAdapter(native as CodexAppServerSessionManager))
    chat = new OperatorChatService(new PostgresOperatorConversationRepository(pool), operators,
      () => manager, directory, authority)
    services.operatorChat = chat
    const conversation = await chat.create(owner)
    conversationId = conversation.id
    const environment = await authority.prepare(manager, configured.configuration, conversation.id,
      owner.id, signal)
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
