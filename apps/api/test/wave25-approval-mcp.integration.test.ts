import { afterEach, describe, expect, it } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { buildApp } from '../src/app.js'
import { PostgresAppInteractionService } from '../src/modules/interactions/app.js'
import { InteractionService } from '../src/modules/interactions/service.js'
import { PostgresApprovalBudgetRepository } from '../src/modules/interactions/budget.js'
import { GraphDraftService } from '../src/modules/graph-drafts/service.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import type { InteractionNativeRuntime } from '../src/modules/interactions/runtimePorts.js'
import { approvalDatabase } from './helpers/wave25ApprovalDatabase.js'

const closes: Array<() => Promise<void>> = []
afterEach(async () => { while (closes.length) await closes.pop()!() })
async function setup() {
  const f = await approvalDatabase(); closes.push(f.close)
  let writes = 0
  const runtime: InteractionNativeRuntime = {
    attachOwnedSession: async () => { throw new Error('No native session may attach in this test.') },
    attachInteraction: async () => { writes++; throw new Error('No native operation is permitted before review settlement.') },
    validateInteraction: async () => undefined,
  }
  const service = new InteractionService(f.repository, new PostgresApprovalBudgetRepository(f.pool), runtime,
    async () => { throw new Error('The legacy resume callback must not run for v2.') })
  // Unrelated services are not granted to these test principals and cannot be
  // invoked. Authentication, MCP transport and changed domain services are real.
  const operatorServices = { commands: f.commands, drafts: new GraphDraftService(f.pool, f.commands),
    approvalDrafts: f.draftService, workspaces: {}, workflows: {}, agents: {}, locations: {}, harnesses: {}, runs: {} } as unknown as OperatorServices
  const app = buildApp({ readiness: { database: f.database, checkpoints: { ping: async () => undefined } },
    operator: { access: f.access, services: operatorServices },
    appMcp: { access: f.access, interactions: new PostgresAppInteractionService(f.pool, f.repository, f.commands, service) } })
  const origin = await app.listen({ host: '127.0.0.1', port: 0 }); closes.push(() => app.close())
  async function connect(path: string, token: string) {
    const client = new Client({ name: 'a4-authenticated-regression', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(path, origin), { requestInit: { headers: { Authorization: `Bearer ${token}` } } })
    await client.connect(transport); closes.push(() => client.close())
    return client
  }
  return { ...f, app, connect, writes: () => writes }
}

describe('A4 authenticated App and Operator MCP with persisted PostgreSQL readback', () => {
  it('App response records one scoped decision; exact replay is safe and no native delivery is inferred', async () => {
    const f = await setup()
    const client = await f.connect('/mcp/tools', f.credential.environment.variables.GRAPHQL_APP_MCP_TOKEN!)
    const tools = await client.listTools()
    expect(tools.tools.some((tool) => tool.name === 'interaction_respond')).toBe(true)
    const args = { interactionId: f.interaction.id, optionId: 'approve-once', expectedRevision: 0 }
    const first = await client.callTool({ name: 'interaction_respond', arguments: args })
    expect(first.isError).not.toBe(true)
    expect((await f.repository.get(f.interaction.id))?.deliveryState).toBe('pending')
    const replay = await client.callTool({ name: 'interaction_respond', arguments: args })
    expect(replay.isError).not.toBe(true)
    const get = await client.callTool({ name: 'interaction_get', arguments: { interactionId: f.interaction.id } })
    expect(get.isError).not.toBe(true)
    expect(JSON.stringify(get.structuredContent)).toContain('approve-once')
    expect((await f.repository.get(f.interaction.id))?.revision).toBe(1)
    expect(f.writes()).toBe(0)
    const conflict = await client.callTool({ name: 'interaction_respond', arguments: { ...args, optionId: 'reject' } })
    expect(conflict.isError).toBe(true)
    expect((await f.pool.query("select * from management_audit where principal_id=$1 and action='interaction_respond'", [f.principal.id])).rowCount).toBeGreaterThanOrEqual(2)
  })
  it('a read-only or revoked App principal cannot decide through MCP', async () => {
    const f = await setup()
    await f.pool.query('update management_principals set grants=$2::jsonb where id=$1', [f.principal.id, JSON.stringify([
      { actions: ['interactions:read'], scope: { workspaceIds: [f.run.workspaceId], workflowIds: [f.run.workflowId], runIds: [f.run.id] } },
    ])])
    const client = await f.connect('/mcp/tools', f.credential.environment.variables.GRAPHQL_APP_MCP_TOKEN!)
    expect((await client.listTools()).tools.some((tool) => tool.name === 'interaction_respond')).toBe(false)
    const denied = await client.callTool({ name: 'interaction_respond', arguments: { interactionId: f.interaction.id, optionId: 'approve-once', expectedRevision: 0 } }).catch(() => ({ isError: true }))
    expect(denied.isError).toBe(true)
    await f.credentials.revoke({ principalId: f.principal.id })
    const revoked = await client.callTool({ name: 'interaction_get', arguments: { interactionId: f.interaction.id } }).catch(() => ({ isError: true }))
    expect(revoked.isError).toBe(true)
    expect((await f.repository.get(f.interaction.id))?.status).toBe('pending')
  })
  it('Operator configures and reads typed approval relationships without touching an active Run', async () => {
    const f = await setup(), client = await f.connect('/mcp/operator', f.operator.token)
    const before = (await f.pool.query('select record from workflow_versions where id=$1', [f.version.id])).rows[0].record
    const input = { executionSemanticsVersion: 2, workspaceId: f.run.workspaceId, workflowId: f.run.workflowId,
      draftId: f.draft.id, expectedRevision: 0, commandId: 'approval-mcp-command', operations: [{ type: 'relationship.put',
        relationship: { id: 'approval-edge', kind: 'approval', source: 'node-reviewer', target: 'node-worker', label: 'Review' } }] }
    const result = await client.callTool({ name: 'graph_draft_apply', arguments: input })
    expect(result.isError).not.toBe(true)
    const get = await client.callTool({ name: 'graph_draft_get', arguments: { workspaceId: f.run.workspaceId, workflowId: f.run.workflowId, draftId: f.draft.id } })
    expect(get.isError).not.toBe(true); expect(JSON.stringify(get.structuredContent)).toContain('approval-edge')
    const stored = await f.draftService.getIfV2(f.operator.principal, f.run.workspaceId, f.run.workflowId, f.draft.id)
    expect(stored?.revision).toBe(1); expect(stored?.graph.edges.find((edge) => edge.id === 'approval-edge')?.kind).toBe('approval')
    expect(stored?.graph.edges.find((edge) => edge.id === 'execution-edge')).toEqual(f.version.definition.edges[0])
    expect((await f.pool.query('select record from workflow_versions where id=$1', [f.version.id])).rows[0].record).toEqual(before)
    const replay = await client.callTool({ name: 'graph_draft_apply', arguments: input }); expect(replay.isError).not.toBe(true)
    expect((await f.draftService.getIfV2(f.operator.principal, f.run.workspaceId, f.run.workflowId, f.draft.id))?.revision).toBe(1)
    const conflict = await client.callTool({ name: 'graph_draft_apply', arguments: { ...input, commandId: 'another-command' } }); expect(conflict.isError).toBe(true)
  })
  it('Operator read-only grants and wrong workspace cannot acquire approval-write authority', async () => {
    const f = await setup()
    const reader = await f.access.issue({ name: 'approval-read-only', audience: 'operator', expiresAt: new Date(Date.now() + 60000),
      grants: [{ actions: ['graph:read'], scope: { workspaceIds: [f.run.workspaceId], workflowIds: [f.run.workflowId] } }] })
    const client = await f.connect('/mcp/operator', reader.token)
    expect((await client.listTools()).tools.some((tool) => tool.name === 'graph_draft_apply')).toBe(false)
    const forbidden = await client.callTool({ name: 'graph_draft_apply', arguments: { executionSemanticsVersion: 2,
      workspaceId: f.run.workspaceId, workflowId: f.run.workflowId, draftId: f.draft.id, expectedRevision: 0, commandId: 'denied',
      operations: [{ type: 'edge.disconnect', edgeId: 'approval-edge' }] } }).catch(() => ({ isError: true }))
    expect(forbidden.isError).toBe(true)
    const hidden = await client.callTool({ name: 'graph_draft_get', arguments: { workspaceId: 'wrong-workspace', workflowId: f.run.workflowId, draftId: f.draft.id } })
    expect(hidden.isError).toBe(true)
    expect((await f.draftService.getIfV2(f.operator.principal, f.run.workspaceId, f.run.workflowId, f.draft.id))?.revision).toBe(0)
  })
  it('authenticated HTTP and Operator MCP share the same typed approval draft revision', async () => {
    const f = await setup()
    const base = `/api/management/workspaces/${f.run.workspaceId}/workflows/${f.run.workflowId}/drafts/${f.draft.id}`
    const input = { executionSemanticsVersion: 2, expectedRevision: 0, commandId: 'approval-http-command',
      operations: [{ type: 'relationship.put', relationship: {
        id: 'approval-edge', kind: 'approval', source: 'node-reviewer', target: 'node-worker', label: 'HTTP review' } }] }
    const response = await f.app.inject({ method: 'POST', url: `${base}/operations`,
      headers: { authorization: `Bearer ${f.operator.token}` }, payload: input })
    expect(response.statusCode).toBe(200)
    const client = await f.connect('/mcp/operator', f.operator.token)
    const readback = await client.callTool({ name: 'graph_draft_get', arguments: {
      workspaceId: f.run.workspaceId, workflowId: f.run.workflowId, draftId: f.draft.id } })
    expect(readback.isError).not.toBe(true)
    expect(JSON.stringify(readback.structuredContent)).toContain('HTTP review')
    expect((await f.draftService.getIfV2(f.operator.principal, f.run.workspaceId, f.run.workflowId, f.draft.id))?.revision).toBe(1)
    const conflict = await f.app.inject({ method: 'POST', url: `${base}/operations`,
      headers: { authorization: `Bearer ${f.operator.token}` }, payload: { ...input, commandId: 'new-stale-http-command' } })
    expect(conflict.statusCode).toBe(409)
  })

})
