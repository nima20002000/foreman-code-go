import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { AgentCreateInputSchema, ManagedAgentDetailSchema } from '@foreman-code/contracts/management'
import { SavedRunDetailsSchema } from '@foreman-code/contracts/wave25'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'

const historicalConfiguration = {
  harness: 'opencode', model: 'saved-provider/model', variant: 'max', nativeAgent: 'build',
  thinking: true, autoApprove: false,
}

it('rejects OpenCode creation through authenticated HTTP and MCP without persisting an Agent', async () => {
  const f = await currentOperatorIntegration({ agentManagement: true })
  try {
    const workspaceId = f.f.scope.workspaceId
    const agentId = randomUUID()
    const input = { workspaceId, agentId, commandId: randomUUID(), name: 'Retired harness choice',
      configuration: historicalConfiguration }
    const tool = (await f.client.listTools()).tools.find(tool => tool.name === 'agent_create')
    expect(tool).toBeDefined()
    const rejected = AgentCreateInputSchema.safeParse(input)
    expect(rejected.success).toBe(false)
    if (rejected.success) throw new Error('The retired harness was accepted as a new choice')
    expect(rejected.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: expect.arrayContaining(['configuration']) }),
    ]))
    const response = await f.app.inject({ method: 'POST',
      url: `/api/management/workspaces/${workspaceId}/agents`,
      headers: { authorization: `Bearer ${f.writer.token}` }, payload: input })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_REQUEST', details: {
      issues: expect.arrayContaining([expect.objectContaining({ path: expect.arrayContaining(['configuration']) })]),
    } } })
    const result = await f.client.callTool({ name: 'agent_create',
      arguments: { ...input, commandId: randomUUID() } })
    expect(result.isError).toBe(true)
    expect(result.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: expect.stringMatching(/configuration|harness/i) }),
    ]))
    expect((await f.db.pool.query('select id from agents where id=$1', [agentId])).rows).toEqual([])
    expect((await f.db.pool.query('select id from agent_configuration_versions where agent_id=$1', [agentId])).rows)
      .toEqual([])

    const reader = await f.access.issue({ name: 'Read-only retired-harness caller', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000),
      grants: [{ actions: ['agents:read', 'harnesses:read'], scope: { workspaceIds: [workspaceId] } }] })
    const readClient = await f.connect(reader.token)
    await expectMcpAccessDenied(readClient.callTool({ name: 'agent_create',
      arguments: { ...input, configuration: DEFAULT_HARNESS_DEFAULTS.codex } }))
    const denied = await f.app.inject({ method: 'POST',
      url: `/api/management/workspaces/${workspaceId}/agents`,
      headers: { authorization: `Bearer ${reader.token}` },
      payload: { ...input, configuration: DEFAULT_HARNESS_DEFAULTS.codex } })
    expect(denied.statusCode).toBe(403)
    const choices = await f.client.callTool({ name: 'harness_list', arguments: {} })
    expect(choices.isError).not.toBe(true)
    expect(choices.structuredContent).toMatchObject({ items: expect.not.arrayContaining([
      expect.objectContaining({ harness: 'opencode' }),
    ]) })
    const listed = await f.app.inject({ method: 'GET', url: '/api/management/harnesses',
      headers: { authorization: `Bearer ${f.writer.token}` } })
    expect(listed.statusCode).toBe(200)
    expect(listed.json()).not.toContainEqual(expect.objectContaining({ harness: 'opencode' }))
  } finally {
    await f.close()
  }
}, 60_000)

it('reads saved OpenCode Agent and Run facts through HTTP and MCP without rewriting them', async () => {
  const f = await currentOperatorIntegration({ agentManagement: true })
  try {
    const configuration = f.f.configurations[0]!
    const historical = { ...configuration, harness: historicalConfiguration }
    await f.db.pool.query('update agent_configuration_versions set record=$2::jsonb where id=$1',
      [configuration.id, JSON.stringify(historical)])
    const snapshots = async () => (await f.db.pool.query<{ configuration: unknown; version: unknown; run: unknown }>(
      `select c.record as configuration, v.record as version, r.record as run
       from agent_configuration_versions c, workflow_versions v, runs r
       where c.id=$1 and v.id=$2 and r.id=$3`, [configuration.id, f.f.version.id, f.f.run.id])).rows[0]!
    const before = await snapshots()
    const args = { workspaceId: f.f.scope.workspaceId, agentId: configuration.agentId }
    const result = await f.client.callTool({ name: 'agent_get', arguments: args })
    expect(result.isError).not.toBe(true)
    const saved = ManagedAgentDetailSchema.parse(result.structuredContent)
    expect(saved.agent.harnessConfiguration).toEqual(historicalConfiguration)
    const http = await f.app.inject({ method: 'GET',
      url: `/api/management/workspaces/${args.workspaceId}/agents/${args.agentId}`,
      headers: { authorization: `Bearer ${f.writer.token}` } })
    expect(http.statusCode).toBe(200)
    expect(ManagedAgentDetailSchema.parse(http.json())).toEqual(saved)
    const version = await new PostgresWorkflowRepository(f.db.pool).getVersion(f.f.version.id)
    expect(version).toEqual(f.f.version)
    const run = await f.client.callTool({ name: 'run_get',
      arguments: { workspaceId: args.workspaceId, runId: f.f.run.id } })
    expect(run.isError).not.toBe(true)
    const details = SavedRunDetailsSchema.parse(run.structuredContent)
    const visibleRun = { ...f.f.run }
    delete visibleRun.authorizationPrincipalId
    expect(details.run).toEqual(visibleRun)
    expect(details.run.agentConfigurationVersionIds[configuration.agentId]).toBe(historical.id)
    const runHttp = await f.app.inject({ method: 'GET',
      url: `/api/management/workspaces/${args.workspaceId}/runs/${f.f.run.id}`,
      headers: { authorization: `Bearer ${f.writer.token}` } })
    expect(runHttp.statusCode).toBe(200)
    expect(SavedRunDetailsSchema.parse(runHttp.json())).toEqual(details)
    const configHttp = await f.app.inject({ method: 'GET',
      url: `/api/management/workspaces/${args.workspaceId}/agents/${args.agentId}/versions/${historical.id}`,
      headers: { authorization: `Bearer ${f.writer.token}` } })
    expect(configHttp.statusCode).toBe(200)
    expect(configHttp.json()).toEqual({ version: historical })
    expect(await snapshots()).toEqual(before)
  } finally {
    await f.close()
  }
}, 60_000)
