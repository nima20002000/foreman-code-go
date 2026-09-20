import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, expect, it } from 'vitest'
import { HarnessMcpListResultSchema, HarnessMcpPlanResultSchema, HarnessMcpPlanSchema } from '@graphql/contracts/management'
import { buildApp } from '../src/app.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { HarnessMcpSettingsService } from '../src/modules/harnesses/mcpSettings.js'
import { fingerprint, replacement, type NativeMcpAdapter, type NativeMcpSnapshot } from '../src/modules/harnesses/nativeMcpCommon.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'

const connectionString = process.env.TEST_DATABASE_URL ?? 'postgresql://graphql:graphql@127.0.0.1:5432/postgres'
const clients: Client[] = []
afterEach(async () => { for (const client of clients.splice(0)) await client.close() })

it('requests exact Operator and Linear presets through authenticated MCP, then applies and reads back both harnesses', async () => {
  const admin = new pg.Pool({ connectionString })
  const schema = `managed_mcp_${randomUUID().replaceAll('-', '')}`
  await admin.query(`create schema "${schema}"`)
  const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` })
  const endpoint = 'http://127.0.0.1:3000/mcp/operator'
  const snapshots = Object.fromEntries((['codex', 'opencode'] as const).map((harness) => [harness,
    { harness, revision: fingerprint({}), effective: {}, user: {}, userConfig: {}, file: '/tmp/config', version: '1' }])) as Record<'codex' | 'opencode', NativeMcpSnapshot>
  const adapter = (harness: 'codex' | 'opencode'): NativeMcpAdapter => ({
    read: async () => structuredClone(snapshots[harness]),
    apply: async (snapshot, change, _signal, managed) => {
      const next = replacement(snapshot, change, managed)
      const user = { ...snapshot.user }
      if (next) user[change.name] = next; else delete user[change.name]
      snapshots[harness] = { ...snapshot, user, effective: structuredClone(user), revision: fingerprint(user),
        credentialReferences: user['graphql-operator'] ? { 'graphql-operator': 'GRAPHQL_OPERATOR_MCP_TOKEN' } : {} }
    },
  })
  const adapters = { codex: adapter('codex'), opencode: adapter('opencode') }
  const access = new PostgresAccessService(pool)
  const commands = new PostgresCommandCoordinator(pool)
  const mcp = new HarnessMcpSettingsService(pool, commands, adapters, () => {}, async () => {}, endpoint)
  const services = { commands, harnessSettings: { mcp, directories: {} } } as unknown as OperatorServices
  const app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services } })
  try {
    await applyApplicationMigrations(pool)
    const owner = await access.issue({ name: 'MCP owner', audience: 'operator', grants: [{ actions: ['harnesses:read', 'harnesses:update'], scope: {} }],
      expiresAt: new Date(Date.now() + 120_000) })
    const delegated = await access.issue({ name: 'MCP requester', audience: 'operator', grants: [{ actions: ['harnesses:read', 'harnesses:update'], scope: {} }],
      expiresAt: new Date(Date.now() + 120_000) })
    await pool.query('update management_principals set delegated_from=$2 where id=$1', [delegated.principal.id, owner.principal.id])
    const reader = await access.issue({ name: 'MCP reader', audience: 'operator', grants: [{ actions: ['harnesses:read'], scope: {} }],
      expiresAt: new Date(Date.now() + 120_000) })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'managed-mcp-test', version: '1' }); clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp/operator', address), { authProvider: { token: async () => token } }))
      return client
    }
    const client = await connect(delegated.token)
    const denied = await connect(reader.token)
    expect((await denied.listTools()).tools.map((tool) => tool.name)).not.toContain('harness_mcp_managed_request')
    await expect(denied.callTool({ name: 'harness_mcp_managed_request', arguments: {} })).rejects.toThrow('not found')
    const listed = async (harness: 'codex' | 'opencode') => HarnessMcpListResultSchema.parse(
      (await client.callTool({ name: 'harness_mcp_servers_list', arguments: { harness } })).structuredContent)
    for (const harness of ['codex', 'opencode'] as const) {
      for (const preset of ['operator', 'linear'] as const) {
        const before = await listed(harness)
        expect(before.presets?.[preset]).toBe('missing')
        const args = { harness, preset, installed: true, expectedRevision: before.revision, commandId: randomUUID() }
        const request = HarnessMcpPlanResultSchema.parse((await client.callTool({ name: 'harness_mcp_managed_request', arguments: args })).structuredContent)
        expect(request.value).toMatchObject({ status: 'pending', managedPreset: preset })
        expect(HarnessMcpPlanResultSchema.parse((await client.callTool({ name: 'harness_mcp_managed_request', arguments: args })).structuredContent).replayed).toBe(true)
        await expect(client.callTool({ name: 'harness_mcp_change_request', arguments: { harness, expectedRevision: before.revision,
          commandId: randomUUID(), change: { kind: 'add', name: 'graphql-operator', connection: { transport: 'remote', url: endpoint } } } })).resolves.toMatchObject({ isError: true })
        const bearerDenied = await app.inject({ method: 'POST', url: '/api/management/harnesses/mcp/managed',
          headers: { authorization: `Bearer ${owner.token}` }, payload: args })
        expect(bearerDenied.statusCode).toBe(403)
        const applied = await mcp.decide(owner.principal, request.value.id, true)
        expect(applied.status).toBe('applied')
        expect(HarnessMcpPlanSchema.parse((await client.callTool({ name: 'harness_mcp_change_get', arguments: { planId: applied.id } })).structuredContent).status).toBe('applied')
        const installedList = await listed(harness)
        expect(installedList.presets?.[preset]).toBe('installed')
        expect(installedList.servers.find((server) => server.name === (preset === 'operator' ? 'graphql-operator' : 'linear'))?.endpoint)
          .toBe(preset === 'operator' ? endpoint : 'https://mcp.linear.app/mcp/readonly')
        if (preset === 'operator') expect(JSON.stringify((await listed(harness)).servers)).not.toContain('GRAPHQL_OPERATOR_MCP_TOKEN')
        const name = preset === 'operator' ? 'graphql-operator' : 'linear'
        const original = structuredClone(snapshots[harness].user[name])
        for (const enabled of [false, true]) {
          const toggle = { harness, preset, enabled, expectedRevision: (await listed(harness)).revision, commandId: randomUUID() }
          const togglePlan = HarnessMcpPlanResultSchema.parse((await client.callTool({ name: 'harness_mcp_managed_request', arguments: toggle })).structuredContent)
          expect(togglePlan.value.change).toEqual({ kind: 'enable', name, enabled })
          expect((await mcp.decide(owner.principal, togglePlan.value.id, true)).status).toBe('applied')
          const toggled = await listed(harness)
          expect(toggled.presets?.[preset]).toBe(enabled ? 'installed' : 'disabled')
          expect(toggled.servers.find((server) => server.name === name)?.enabled).toBe(enabled)
          expect(snapshots[harness].user[name]).toEqual({ ...original as object, enabled })
          if (!enabled) {
            const disabledRemoval = { harness, preset, installed: false, expectedRevision: toggled.revision, commandId: randomUUID() }
            const disabledPlan = HarnessMcpPlanResultSchema.parse((await client.callTool({ name: 'harness_mcp_managed_request', arguments: disabledRemoval })).structuredContent)
            expect(disabledPlan.value.change.kind).toBe('remove')
            expect((await mcp.decide(owner.principal, disabledPlan.value.id, false)).status).toBe('rejected')
          }
        }
        const removal = { harness, preset, installed: false, expectedRevision: (await listed(harness)).revision, commandId: randomUUID() }
        const removePlan = HarnessMcpPlanResultSchema.parse((await client.callTool({ name: 'harness_mcp_managed_request', arguments: removal })).structuredContent)
        expect((await mcp.decide(owner.principal, removePlan.value.id, true)).status).toBe('applied')
        expect((await listed(harness)).presets?.[preset]).toBe('missing')
      }
    }
  } finally {
    await mcp.shutdown(); await app.close(); await pool.end()
    await admin.query(`drop schema if exists "${schema}" cascade`); await admin.end()
  }
})
