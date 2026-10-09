import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { createFixtureSchema, dropFixtureSchema } from './helpers/testResources.js'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, expect, it } from 'vitest'
import { HarnessMcpListResultSchema, HarnessMcpPlanSchema } from '@foreman-code/contracts/management'
import { buildApp } from '../src/app.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { HarnessMcpSettingsService } from '../src/modules/harnesses/mcpSettings.js'
import { applyMcpEdits, fingerprint, mcpEdits, type NativeMcpAdapter, type NativeMcpSnapshot } from '../src/modules/harnesses/nativeMcpCommon.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'

const connectionString = process.env.TEST_DATABASE_URL!
const clients: Client[] = []
afterEach(async () => { for (const client of clients.splice(0)) await client.close() })

it('requests exact Foreman Code and Linear presets through authenticated MCP, then applies and reads back both harnesses', async () => {
  const admin = new pg.Pool({ connectionString })
  const schema = `managed_mcp_${randomUUID().replaceAll('-', '')}`
  await createFixtureSchema(admin, schema)
  const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` })
  const endpoint = 'http://127.0.0.1:3000/mcp'
  const snapshots = Object.fromEntries((['codex'] as const).map((harness) => [harness,
    { harness, revision: fingerprint({}), effective: {}, user: {}, userConfig: {}, file: '/tmp/config', version: '1' }])) as Record<'codex', NativeMcpSnapshot>
  const adapter = (harness: 'codex'): NativeMcpAdapter => ({
    read: async () => structuredClone(snapshots[harness]),
    apply: async (snapshot, change, _signal, managed) => {
      const user = applyMcpEdits(snapshot.user, mcpEdits(snapshot, change, managed))
      snapshots[harness] = { ...snapshot, user, effective: structuredClone(user), revision: fingerprint(user),
        }
    },
  })
  const adapters = { codex: adapter('codex') }
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
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
      return client
    }
    const client = await connect(delegated.token)
    const denied = await connect(reader.token)
    expect((await denied.listTools()).tools.map((tool) => tool.name)).not.toContain('harness_mcp_managed_request')
    const deniedRequest = await denied.callTool({ name: 'harness_mcp_managed_request', arguments: {} })
    expect(deniedRequest.isError).toBe(true)
    expect(JSON.stringify(deniedRequest.content)).toContain('ACCESS_DENIED')
    const listed = async (harness: 'codex') => HarnessMcpListResultSchema.parse(
      decodeMcpToolResult((await client.callTool({ name: 'harness_mcp_servers_list', arguments: { harness } }))))
    for (const harness of ['codex'] as const) {
      for (const preset of ['graphql', 'linear'] as const) {
        const before = await listed(harness)
        expect(before.presets?.[preset]).toBe('missing')
        const args = { harness, preset, installed: true, expectedRevision: before.revision, commandId: randomUUID() }
        // The delegated Operator applies the preset itself: no human review step.
        const applied = HarnessMcpPlanSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'harness_mcp_managed_request', arguments: args }))))
        expect(applied).toMatchObject({ status: 'applied', managedPreset: preset })
        expect(HarnessMcpPlanSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'harness_mcp_managed_request', arguments: args }))))).toEqual(applied)
        await expect(client.callTool({ name: 'harness_mcp_change_request', arguments: { harness, expectedRevision: before.revision,
          commandId: randomUUID(), change: { kind: 'add', name: 'graphql', connection: { transport: 'remote', url: endpoint } } } })).resolves.toMatchObject({ isError: true })
        const bearerDenied = await app.inject({ method: 'POST', url: '/api/management/harnesses/mcp/managed',
          headers: { authorization: `Bearer ${owner.token}` }, payload: args })
        expect(bearerDenied.statusCode).toBe(403)
        expect(HarnessMcpPlanSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'harness_mcp_change_get', arguments: { planId: applied.id } })))).status).toBe('applied')
        const installedList = await listed(harness)
        expect(installedList.presets?.[preset]).toBe('installed')
        expect(installedList.servers.find((server) => server.name === (preset === 'graphql' ? 'foreman-code' : preset))?.endpoint)
          .toBe(preset !== 'linear' ? undefined : 'https://mcp.linear.app/mcp/readonly')
        if (preset === 'graphql') expect(installedList.servers.find((server) => server.name === 'foreman-code')?.transport).toBe('stdio')
        if (preset === 'graphql') expect(JSON.stringify((await listed(harness)).servers)).not.toContain('GRAPHQL_MCP_TOKEN')
        const name = preset === 'graphql' ? 'foreman-code' : preset
        const original = structuredClone(snapshots[harness].user[name])
        for (const enabled of [false, true]) {
          const toggle = { harness, preset, enabled, expectedRevision: (await listed(harness)).revision, commandId: randomUUID() }
          const togglePlan = HarnessMcpPlanSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'harness_mcp_managed_request', arguments: toggle }))))
          expect(togglePlan.change).toEqual({ kind: 'enable', name, enabled })
          expect(togglePlan.status).toBe('applied')
          const toggled = await listed(harness)
          expect(toggled.presets?.[preset]).toBe(enabled ? 'installed' : 'disabled')
          expect(toggled.servers.find((server) => server.name === name)?.enabled).toBe(enabled)
          expect(snapshots[harness].user[name]).toEqual({ ...original as object, enabled })
        }
        const removal = { harness, preset, installed: false, expectedRevision: (await listed(harness)).revision, commandId: randomUUID() }
        const removePlan = HarnessMcpPlanSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'harness_mcp_managed_request', arguments: removal }))))
        expect(removePlan).toMatchObject({ status: 'applied', change: { kind: 'remove' } })
        expect((await listed(harness)).presets?.[preset]).toBe('missing')
      }
      // Retired per-role entries are replaced by the one graphql entry in the same reviewed write.
      const legacy = { 'graphql-app': { enabled: true }, 'graphql-operator': { enabled: true } }
      snapshots[harness] = { ...snapshots[harness], user: legacy, effective: structuredClone(legacy), revision: fingerprint(legacy) }
      const before = await listed(harness)
      expect(before.presets?.graphql).toBe('legacy')
      expect(before.servers.find((server) => server.name === 'graphql-app')?.label).toBe('Legacy app connection · replaced by foreman-code')
      const upgrade = HarnessMcpPlanSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'harness_mcp_managed_request', arguments: {
        harness, preset: 'graphql', installed: true, expectedRevision: before.revision, commandId: randomUUID() } }))))
      expect(upgrade.status).toBe('applied')
      expect(Object.keys(snapshots[harness].user)).toEqual(['foreman-code'])
      expect((await listed(harness)).presets?.graphql).toBe('installed')
      const installed = snapshots[harness].user['foreman-code']
      const oldEntry = { ...installed as Record<string, unknown>, enabled: false, disabled_tools: ['interaction_respond'] }
      const oldUser = { graphql: oldEntry }
      snapshots[harness] = { ...snapshots[harness], user: oldUser, effective: structuredClone(oldUser),
        revision: fingerprint(oldUser), }
      expect((await listed(harness)).presets?.graphql).toBe('disabled')
      const rename = HarnessMcpPlanSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'harness_mcp_managed_request', arguments: {
        harness, preset: 'graphql', installed: true, expectedRevision: (await listed(harness)).revision, commandId: randomUUID(),
      } }))))
      expect(rename).toMatchObject({ status: 'applied', change: { name: 'foreman-code' } })
      const renamed = await listed(harness)
      expect(renamed.presets?.graphql).toBe('disabled')
      expect(renamed.servers.map(server => server.name)).toEqual(['foreman-code'])
      expect(snapshots[harness].user['foreman-code']).toMatchObject({ enabled: false, disabled_tools: ['interaction_respond'] })
    }
    const audits = await pool.query<{ principal_id: string; source: string }>("select principal_id,source from management_audit where action='harness.mcp.apply'")
    expect(audits.rows.length).toBeGreaterThan(0)
    expect(new Set(audits.rows.map((row) => `${row.principal_id}:${row.source}`))).toEqual(new Set([`${delegated.principal.id}:mcp`]))
  } finally {
    await mcp.shutdown(); await app.close(); await pool.end()
    await dropFixtureSchema(admin, schema); await admin.end()
  }
}, 30_000)
