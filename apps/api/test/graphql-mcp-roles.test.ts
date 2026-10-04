import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { ManagementActionSchema, type ManagementPrincipal } from '@foreman-code/contracts/management'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AppInteractionService } from '../src/modules/interactions/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { createGraphqlMcpServer, roleDeniedToolCall } from '../src/mcp/unified/server.js'
import type { McpRole } from '../src/mcp/unified/roles.js'

const operator: ManagementPrincipal = { id: 'operator-1', name: 'Operator', audience: 'operator',
  expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null, grants: [{ actions: [...ManagementActionSchema.options], scope: {} }] }
const worker: ManagementPrincipal = { id: 'worker-1', name: 'Worker', audience: 'worker', agentId: 'agent-1',
  expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null, grants: [] }
const recordDenied = vi.fn(async () => undefined)
// Registration only checks that services exist; no handler below reaches them.
const services = { commands: { recordDenied }, settings: {}, interactions: {}, runs: {}, workflows: {}, workspaces: {} } as unknown as OperatorServices
const interactions = (respond: boolean) => ({
  canRead: async () => true, canRespond: async () => respond,
  context: async () => ({}), list: async () => ({ items: [], nextCursor: null }), get: async () => ({}), respond: async () => ({}),
}) as unknown as AppInteractionService

const clients: Client[] = []
afterEach(async () => { await Promise.all(clients.splice(0).map((client) => client.close())); recordDenied.mockClear() })
const context = (role: McpRole, tools?: string[]) => ({ role, principal: role === 'operator' ? operator : worker,
  operator: services, interactions: interactions(role === 'orchestrator'), ...(tools ? { tools } : {}) })
async function connect(role: McpRole, tools?: string[]) {
  const server = await createGraphqlMcpServer(context(role, tools))
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: `graphql-${role}`, version: '1' }); clients.push(client)
  await client.connect(clientTransport)
  return client
}
const call = (name: string) => ({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: {} } })
async function deniedText(role: McpRole, name: string, tools?: string[]): Promise<string> {
  const response = await roleDeniedToolCall(context(role, tools), call(name))
  expect(response?.id).toBe(7)
  expect(response?.result.isError).toBe(true)
  return (response!.result.content as Array<{ text: string }>).map((part) => part.text).join('\n')
}

describe('one Foreman Code MCP server scoped by role', () => {
  it('lists only the tools each role may use and tells the model its role', async () => {
    const [op, orchestrator, coder] = await Promise.all([connect('operator'), connect('orchestrator'), connect('coder')])
    const names = async (client: Client) => (await client.listTools()).tools.map((tool) => tool.name).sort()
    const operatorNames = await names(op)
    expect(operatorNames).toContain('workflow_create')
    expect(operatorNames).toContain('interaction_get')
    expect(operatorNames).not.toContain('context_get')
    expect(operatorNames).not.toContain('interaction_respond')
    expect(await names(orchestrator)).toEqual(['context_get', 'interaction_get', 'interaction_list', 'interaction_respond'])
    expect(await names(coder)).toEqual(['context_get', 'interaction_get', 'interaction_list'])
    expect(coder.getServerVersion()).toMatchObject({ name: 'foreman-code', title: 'Foreman Code MCP' })
    expect(coder.getInstructions()).toContain('Foreman Code')
    expect(coder.getInstructions()).toContain('Coder role')
    expect(op.getInstructions()).toContain('Operator role')
  })

  it('refuses a direct call to a tool outside the caller role with an audited ROLE_NOT_ALLOWED', async () => {
    expect(await deniedText('coder', 'workflow_create')).toContain('ROLE_NOT_ALLOWED')
    expect(await deniedText('coder', 'interaction_respond')).toContain('Your Coder role cannot use interaction_respond. Allowed roles: Orchestrator.')
    expect(recordDenied).toHaveBeenCalledWith('worker-1', 'mcp', 'workflow_create', 'mcp:workflow_create')
    expect(await deniedText('operator', 'context_get')).toContain('Your Operator role cannot use context_get. Allowed roles: Orchestrator, Coder.')
    expect(await deniedText('orchestrator', 'workspace_list')).toContain('Your Orchestrator role cannot use workspace_list. Allowed roles: Operator.')
    // Allowed tools, unknown names and other methods pass through to the server.
    expect(await roleDeniedToolCall(context('coder'), call('context_get'))).toBeUndefined()
    expect(await roleDeniedToolCall(context('coder'), call('no_such_tool'))).toBeUndefined()
    expect(await roleDeniedToolCall(context('coder'), { jsonrpc: '2.0', id: 1, method: 'tools/list' })).toBeUndefined()
    const coder = await connect('coder')
    expect((await coder.listTools()).tools.find((tool) => tool.name === 'interaction_get')?.inputSchema.additionalProperties).toBe(false)
  })

  it('lists only the tools enabled for the Agent and refuses the rest with TOOL_NOT_ENABLED', async () => {
    const coder = await connect('coder', ['context_get'])
    expect((await coder.listTools()).tools.map((tool) => tool.name)).toEqual(['context_get'])
    expect(await deniedText('coder', 'interaction_list', ['context_get']))
      .toContain('This Agent does not have interaction_list enabled in its Foreman Code MCP tools. Enabled: context_get.')
    // The role ceiling still wins over an Agent's tool list.
    expect(await deniedText('coder', 'workflow_create', ['context_get'])).toContain('ROLE_NOT_ALLOWED')
    expect(await roleDeniedToolCall(context('coder', ['context_get']), call('context_get'))).toBeUndefined()
  })
})
