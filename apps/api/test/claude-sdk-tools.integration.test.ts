import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { ClaudeHarnessConfiguration } from '@graphql/contracts/claude'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { buildApp } from '../src/app.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { WorkspaceManagementService } from '../src/modules/workspaces/management.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { OperatorChatService, PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChat.js'
import { registerProductionFileStorage } from '../src/modules/files/production.js'
import { productionFileTools } from '../src/modules/files/tools/production.js'
import { nim2691TaskDatabase } from './helpers/nim2691Database.js'
import { graphRpc, graphRpcValue } from './eng04-graph-composition-fixture.js'
import { productionClaudeFixture } from './support/claudeProduction.js'
import { claudeSdkToolTransport } from './support/claudeSdkToolTransport.js'

it.each(['management', 'denied-management', 'files'] as const)(
  'executes %s through the official SDK and production composition with persisted readback', async scenario => {
    await nim2691TaskDatabase(async (pool, directory) => {
      await applyApplicationMigrations(pool)
      const access = new PostgresAccessService(pool)
      const permissions = ['operator_chat:read', 'operator_chat:write', 'operator_chat:respond', 'workspaces:read'] as const
      const owner = await access.issue({ name: 'SDK tool owner', audience: 'operator',
        grants: [{ actions: [...permissions, ...(scenario === 'denied-management' ? [] : ['workspaces:create' as const])], scope: {} }],
        expiresAt: new Date(Date.now() + 600_000) })
      const reader = await access.issue({ name: 'SDK tool reader', audience: 'operator',
        grants: [{ actions: ['operator_chat:read'], scope: {} }], expiresAt: new Date(Date.now() + 600_000) })
      const repository = new PostgresOperatorConversationRepository(pool)
      const operators = new PostgresOperatorRepository(pool)
      const commands = new PostgresCommandCoordinator(pool)
      const locations = new WorkspaceLocationService(pool, commands)
      const workspaces = new WorkspaceManagementService(pool, commands, locations)
      let chat!: OperatorChatService
      const app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
        operator: { access, services: { commands, locations, workspaces,
          operatorChat: { get: (...args: Parameters<OperatorChatService['get']>) => chat.get(...args),
            respond: (...args: Parameters<OperatorChatService['respond']>) => chat.respond(...args) },
        } as OperatorServices } })
      const files = registerProductionFileStorage(app, pool, {
        host: '127.0.0.1', port: 0, readinessTimeoutMs: 2_000,
        database: { connectionString: 'postgresql://graphql:graphql@127.0.0.1/graphql_test',
          maxConnections: 4, connectionTimeoutMs: 2_000, queryTimeoutMs: 5_000 }, checkpoints: { schema: 'langgraph' },
        fileStorageRoot: join(directory, 'vault'), workspaceStorageRoot: join(directory, 'workspaces'),
        harnesses: { workspaceRoot: join(directory, 'runtime'), codexBinary: 'unused', openCodeBinary: 'unused', timeoutMs: 10_000 },
      })
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      const endpoint = `${address}/mcp`
      const tool = scenario === 'files' ? 'mcp__graphql-files__files.read' : 'mcp__graphql__workspace_create'
      const harness: ClaudeHarnessConfiguration = { harness: 'claude', model: 'recorded-model', authMode: 'subscription',
        configDirectory: '/recorded/profile', permissionMode: 'default', sandbox: 'read-only', tools: [tool],
        permissionRules: [{ tool, effect: 'ask' }], instructions: '',
        mcpServers: scenario === 'files' ? {} : { graphql: { type: 'http', url: endpoint } } }
      await operators.update(harness, (await operators.ensure()).configuration.id)
      const configuration = (await operators.ensure()).configuration
      const conversation = await repository.create(configuration.operatorId, configuration, owner.principal.id)
      const requestId = randomUUID()
      let arguments_: Record<string, unknown> = { commandId: randomUUID(), name: `SDK workspace ${randomUUID()}` }
      if (scenario === 'files') {
        const bytes = Buffer.from('# File read by the official SDK\n')
        const uploadId = randomUUID()
        const target = { kind: 'operator' as const, conversationId: conversation.id }
        await files.allocate(owner.principal, target, { requestId: uploadId, filename: 'sdk.md', mediaType: 'text/markdown',
          byteSize: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
        await files.upload(owner.principal, target, uploadId, Readable.from([bytes]))
        const ready = await files.finalize(owner.principal, target, uploadId)
        arguments_ = { fileId: ready.file.fileId, revisionId: ready.revision.revisionId }
      }
      const transport = claudeSdkToolTransport(directory, () => [{ name: scenario === 'files' ? 'files.read' : 'workspace_create',
        arguments: arguments_, server: scenario === 'files' ? 'graphql-files' : 'graphql', source: scenario === 'files' ? 'sdk' : 'dynamic' }])
      const start = { kind: 'operator' as const, correlationId: `operator:${conversation.id}:${requestId}`, configuration,
        workingDirectory: directory, environment: { agentId: configuration.operatorId, variables: {} } }
      const f = productionClaudeFixture('operator', undefined, endpoint, scenario === 'files' ? productionFileTools(app) : undefined,
        { database: pool, binding: { kind: 'operator', conversationId: conversation.id, repository }, start, sdk: transport.sdk })
      chat = new OperatorChatService(repository, operators, () => f.manager, directory, {
        current: id => access.currentOperator(id), assertConfiguration() {},
        setup: async () => ({ harness: 'claude', status: 'configured', endpoint, checkedAt: new Date().toISOString() }),
        prepare: async () => {
          await f.manager.prepareInspection(start)
          if (scenario !== 'files') {
            const scoped = { ...start, environment: { agentId: configuration.operatorId, variables: { GRAPHQL_MCP_TOKEN: owner.token } } }
            await f.manager.refreshInspectionCredentials(scoped, { graphql: { type: 'http', url: endpoint,
              headers: { Authorization: `Bearer ${owner.token}` } } })
            return scoped.environment
          }
          return start.environment
        }, release: async () => {},
      })
      try {
        await chat.send(conversation.id, { requestId, content: 'Call the configured tool' }, owner.principal)
        if (scenario !== 'denied-management') {
          await vi.waitFor(async () => expect((await repository.get(conversation.id))?.pendingInteraction).toBeDefined())
          const pending = (await repository.get(conversation.id))!.pendingInteraction!
          const input = { commandId: randomUUID(), requestId, nativeRequestId: pending.turn.nativeRequestId,
            optionId: pending.responseOptions[0]!.optionId }
          const denied = await graphRpc(app, reader.token, 'tools/call', { name: 'operator_chat_respond',
            arguments: { conversationId: conversation.id, request: input } })
          expect(denied.error || denied.result?.isError).toBeTruthy()
          const approved = await graphRpc(app, owner.token, 'tools/call', { name: 'operator_chat_respond',
            arguments: { conversationId: conversation.id, request: input } })
          // Hook acknowledgment arrives after the permission control response.
          expect(approved.result || approved.error).toBeDefined()
        }
        await vi.waitFor(async () => { await chat.reconcileActive(); expect((await chat.get(conversation.id, owner.principal)).activeRequestId).toBeNull() },
          { timeout: 15_000 })
        expect(transport.offers).toHaveLength(1)
        expect(transport.results).toHaveLength(1)
        expect(transport.results[0]!.allowed).toBe(scenario !== 'denied-management')
        if (scenario === 'management') {
          const result = transport.results[0]!.result as { isError?: boolean; structuredContent: { value: { workspace: { id: string } } } }
          expect(result.isError).not.toBe(true)
          const id = result.structuredContent.value.workspace.id
          const read = await graphRpc(app, owner.token, 'tools/call', { name: 'workspace_get', arguments: { workspaceId: id } })
          expect(graphRpcValue(read.result)).toMatchObject({ workspace: { id, name: arguments_.name } })
          expect((await pool.query('select record from workspaces where id=$1', [id])).rows[0]?.record)
            .toMatchObject({ id, name: arguments_.name })
        } else if (scenario === 'files') {
          expect(transport.results[0]!.result).toMatchObject({ structuredContent: {
            contentBase64: Buffer.from('# File read by the official SDK\n').toString('base64'),
          } })
          expect((await pool.query('select count(*)::int as n from file_tool_sessions where revoked_at is null')).rows[0]?.n).toBe(0)
        } else expect((await pool.query("select count(*)::int as n from workspaces where record->>'name'=$1", [arguments_.name])).rows[0]?.n).toBe(0)
        if (scenario !== 'denied-management') {
          const receipt = (await pool.query("select result from management_command_receipts where operation='operator_chat_control' and target_key=$1",
            [conversation.id])).rows[0]?.result
          expect(receipt).toMatchObject({ status: 'completed', providerAcknowledgment: { semantic: 'approve_once' } })
        }
      } finally { await chat.shutdown(); await app.close() }
    })
  }, 60_000)
