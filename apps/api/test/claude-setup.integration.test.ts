import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { ClaudeSetupOptionsSchema } from '@foreman-code/contracts/claude'
import { HarnessDefaultsUpdateResultSchema, ExecutionReadinessSchema, type HarnessOptions } from '@foreman-code/contracts/management'
import { HarnessCatalogService } from '../src/modules/harnesses/catalog.js'
import { NativeHarnessConfigurationQualifier } from '../src/modules/harnesses/nativeConfigurationQualifier.js'
import { ExecutionReadinessService } from '../src/modules/harnesses/executionReadiness.js'
import { NativeRollout } from '../src/modules/harnesses/nativeRollout.js'
import { PostgresSettingsRepository } from '../src/modules/settings/postgres.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { buildApp } from '../src/app.js'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { initializeNativeDefaults } from '../src/modules/harnesses/initializeDefaults.js'

/** Real authenticated transport and persisted settings. Claude's actual factory
 * blocks qualification before native effects; no fabricated proof/model turn. */
it.skipIf(!postgresEnabled)('configures Claude MCP through authenticated HTTP/MCP with denied writes, persisted readback and truthful blocked readiness', async () => {
  const f = await currentOperatorIntegration()
  const catalog = new HarnessCatalogService(new NativeHarnessConfigurationQualifier('codex', 'opencode'),
    new PostgresSettingsRepository(f.db.pool), f.commands, f.db.directory, new URL('/mcp', f.address).href)
  const app = buildApp({ readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
    operator: { access: f.access, services: { ...f.services, harnesses: catalog, executionReadiness: new ExecutionReadinessService(new NativeRollout({}), catalog) } } })
  const clients: Client[] = []
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const connect = async (token: string) => {
    const client = new Client({ name: 'claude-setup-test', version: '1' }); clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
    return client
  }
  try {
    const client = await connect(f.writer.token)
    const result = (value: { isError?: boolean | undefined; structuredContent?: unknown }) => { expect(value.isError).not.toBe(true); return value.structuredContent }
    const before = ExecutionReadinessSchema.parse(result(await client.callTool({ name: 'execution_readiness_get', arguments: { harness: 'claude' } })))
    expect(before).toMatchObject({ status: 'blocked', reason: { code: 'HARNESS_PROFILE_REQUIRED' } })
    const setup = ClaudeSetupOptionsSchema.parse(result(await client.callTool({ name: 'claude_setup_options_get', arguments: {} })))
    expect(setup.graphqlMcp).toEqual({ type: 'http', url: new URL('/mcp', f.address).href })
    const http = await fetch(new URL('/api/management/harnesses/claude/setup-options', address), { headers: { authorization: `Bearer ${f.writer.token}` } })
    expect(http.status).toBe(200); expect(await http.json()).toEqual(setup)
    const original = await new PostgresSettingsRepository(f.db.pool).getManagedHarnessDefaults()
    const configuration = { harness: 'claude', model: 'explicit-model', authMode: 'subscription', configDirectory: f.db.directory,
      permissionMode: 'default', sandbox: 'danger-full-access', tools: [], permissionRules: [], instructions: '', mcpServers: { graphql: setup.graphqlMcp } }
    const input = { commandId: randomUUID(), expectedRevision: original.revision, defaults: { ...original.defaults, claude: configuration } }
    const reader = await f.access.issue({ name: 'Claude setup reader', audience: 'operator', expiresAt: new Date(Date.now() + 600000), grants: [{ actions: ['harnesses:read'], scope: {} }] })
    const readClient = await connect(reader.token)
    expect(ClaudeSetupOptionsSchema.parse(result(await readClient.callTool({ name: 'claude_setup_options_get', arguments: {} })))).toEqual(setup)
    await expectMcpAccessDenied(readClient.callTool({ name: 'harness_defaults_update', arguments: input }))
    const denied = await fetch(new URL('/api/management/harnesses/defaults', address), { method: 'PUT',
      headers: { authorization: `Bearer ${reader.token}`, 'content-type': 'application/json' }, body: JSON.stringify(input) })
    expect(denied.status).toBe(403)
    expect((await new PostgresSettingsRepository(f.db.pool).getManagedHarnessDefaults()).revision).toBe(original.revision)
    const external = { ...input, commandId: randomUUID(), defaults: { ...input.defaults, claude: {
      ...configuration, tools: ['mcp__external__lookup'],
      permissionRules: [{ tool: 'mcp__external__lookup', effect: 'allow' }],
      mcpServers: { external: { type: 'http', url: 'https://external.example/mcp' } },
    } } }
    const rejected = await client.callTool({ name: 'harness_defaults_update', arguments: external })
    expect(rejected).toMatchObject({ isError: true,
      content: [{ type: 'text', text: expect.stringContaining('External MCP servers are not supported') }] })
    const rejectedHttp = await fetch(new URL('/api/management/harnesses/defaults', address), { method: 'PUT',
      headers: { authorization: `Bearer ${f.writer.token}`, 'content-type': 'application/json' }, body: JSON.stringify(external) })
    expect(rejectedHttp.status).toBe(400)
    expect(await new PostgresSettingsRepository(f.db.pool).getManagedHarnessDefaults()).toEqual(original)
    const saved = HarnessDefaultsUpdateResultSchema.parse(result(await client.callTool({ name: 'harness_defaults_update', arguments: input })))
    expect(saved.value.defaults.claude).toEqual(configuration)
    expect(HarnessDefaultsUpdateResultSchema.parse(result(await client.callTool({ name: 'harness_defaults_update', arguments: input })))).toEqual({ ...saved, replayed: true })
    expect(result(await client.callTool({ name: 'harness_get', arguments: { harness: 'claude' } }))).toMatchObject({ defaults: configuration,
      defaultsRevision: saved.value.revision, capability: null, discoveryError: { code: 'CLAUDE_NATIVE_QUALIFICATION_UNAVAILABLE' } })
    expect(ExecutionReadinessSchema.parse(result(await client.callTool({ name: 'execution_readiness_get', arguments: { harness: 'claude' } })))).toMatchObject({
      status: 'blocked', defaultsRevision: saved.value.revision, reason: { code: 'CLAUDE_NATIVE_QUALIFICATION_UNAVAILABLE' },
    })
    const none = await f.access.issue({ name: 'No Claude setup access', audience: 'operator', expiresAt: new Date(Date.now() + 600000), grants: [] })
    await expectMcpAccessDenied((await connect(none.token)).callTool({ name: 'claude_setup_options_get', arguments: {} }))
    const audit = await f.db.pool.query("select source,action from management_audit where principal_id=$1 and action='harness.defaults.update'", [f.writer.principal.id])
    expect(audit.rows).toContainEqual({ source: 'mcp', action: 'harness.defaults.update' })
  } finally { await Promise.allSettled(clients.map(client => client.close())); await app.close(); await catalog.shutdownChecks(); await f.close() }
}, 60000)

it.skipIf(!postgresEnabled)('keeps fresh Claude board defaults incomplete until an authorized explicit Full access save', async () => {
  const f = await currentOperatorIntegration()
  const repository = new PostgresSettingsRepository(f.db.pool)
  const catalog = new HarnessCatalogService(new NativeHarnessConfigurationQualifier('codex', 'opencode'),
    repository, f.commands, f.db.directory)
  const app = buildApp({ readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
    operator: { access: f.access, services: { ...f.services, harnesses: catalog,
      executionReadiness: new ExecutionReadinessService(new NativeRollout({}), catalog) } } })
  const clients: Client[] = []
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const connect = async (token: string) => {
    const client = new Client({ name: 'claude-defaults-test', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
    return client
  }
  const options = async (harness: HarnessOptions['harness']): Promise<HarnessOptions> => ({
    harness, providerVersion: 'unit-catalog', authenticated: true,
    models: [{ id: 'detected-model', defaultPriority: 0, reasoningEfforts: ['medium'], variants: [], serviceTiers: ['standard'] }],
    nativeAgents: ['build'], settings: [], restrictions: [], checkedAt: new Date().toISOString(),
  })
  try {
    // Only Claude requires discovery in this fixture; existing Codex/OpenCode defaults are explicit.
    await initializeNativeDefaults({ pool: f.db.pool, options, appMcpEndpoint: new URL('/mcp', address).href })
    const original = await repository.getManagedHarnessDefaults()
    expect(original.defaults.claude?.sandbox).toBe('read-only')
    expect(original.unavailable).toContain('claude')
    const client = await connect(f.writer.token)
    const reader = await f.access.issue({ name: 'Claude defaults reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 120_000), grants: [{ actions: ['harnesses:read'], scope: {} }] })
    const readClient = await connect(reader.token)
    expect((await readClient.callTool({ name: 'harness_get', arguments: { harness: 'claude' } })).structuredContent)
      .toMatchObject({ defaults: original.defaults.claude, capability: null,
        discoveryError: { code: 'CLAUDE_FULL_ACCESS_REQUIRED' } })
    expect((await readClient.callTool({ name: 'execution_readiness_get', arguments: { harness: 'claude' } })).structuredContent)
      .toMatchObject({ status: 'blocked', reason: { code: 'CLAUDE_FULL_ACCESS_REQUIRED' } })
    await initializeNativeDefaults({ pool: f.db.pool, options, appMcpEndpoint: new URL('/mcp', address).href })
    expect(await repository.getManagedHarnessDefaults()).toEqual(original)
    const input = { commandId: randomUUID(), expectedRevision: original.revision, configure: ['claude'],
      defaults: { ...original.defaults, claude: { ...original.defaults.claude!, sandbox: 'danger-full-access' } } }
    await expectMcpAccessDenied(readClient.callTool({ name: 'harness_defaults_update', arguments: input }))
    const unsupported = await client.callTool({ name: 'harness_defaults_update', arguments: {
      ...input, commandId: randomUUID(), defaults: original.defaults,
    } })
    expect(unsupported).toMatchObject({ isError: true,
      content: [{ type: 'text', text: expect.stringContaining('Claude requires Full access') }] })
    expect(await repository.getManagedHarnessDefaults()).toEqual(original)
    const saved = HarnessDefaultsUpdateResultSchema.parse((await client.callTool({ name: 'harness_defaults_update', arguments: input })).structuredContent)
    expect(saved.value.defaults.claude?.sandbox).toBe('danger-full-access')
    expect((await repository.getManagedHarnessDefaults()).unavailable ?? []).not.toContain('claude')
    expect((await readClient.callTool({ name: 'harness_get', arguments: { harness: 'claude' } })).structuredContent)
      .toMatchObject({ defaults: saved.value.defaults.claude, defaultsRevision: saved.value.revision })
  } finally {
    await Promise.allSettled(clients.map(client => client.close()))
    await app.close()
    await catalog.shutdownChecks()
    await f.close()
  }
}, 60_000)
