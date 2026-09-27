import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { ManagementActionSchema, type ManagementPrincipal } from '@graphql/contracts/management'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AppInteractionService } from '../src/modules/interactions/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { createGraphqlMcpServer } from '../src/mcp/unified/server.js'
import type { McpRole } from '../src/mcp/unified/roles.js'

const operator: ManagementPrincipal = { id: 'operator-1', name: 'Operator', audience: 'operator',
  expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null, grants: [{ actions: [...ManagementActionSchema.options], scope: {} }] }
const worker: ManagementPrincipal = { id: 'worker-1', name: 'Worker', audience: 'worker', agentId: 'agent-1',
  expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null, grants: [] }
const recordDenied = vi.fn(async () => undefined)
// Registration only checks that services exist; no handler below reaches them.
const services = { commands: { recordDenied }, settings: {}, interactions: {}, runs: {}, workflows: {}, workspaces: {} } as unknown as OperatorServices
const interactions = (respond: boolean) => ({
  canRead: async () => true, canRespond: async () => respond, role: async () => respond ? 'orchestrator' : 'coder',
  context: async () => ({}), list: async () => ({ items: [], nextCursor: null }), get: async () => ({}), respond: async () => ({}),
}) as unknown as AppInteractionService

const clients: Client[] = []
afterEach(async () => { await Promise.all(clients.splice(0).map((client) => client.close())); recordDenied.mockClear() })
async function connect(role: McpRole) {
  const server = await createGraphqlMcpServer({ role, principal: role === 'operator' ? operator : worker,
    operator: services, interactions: interactions(role === 'orchestrator') })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: `graphql-${role}`, version: '1' }); clients.push(client)
  await client.connect(clientTransport)
  return client
}
function errorText(result: Awaited<ReturnType<Client['callTool']>>): string {
  expect(result.isError).toBe(true)
  return (result.content as Array<{ text: string }>).map((part) => part.text).join('\n')
}

describe('one GraphQL MCP server scoped by role', () => {
  it('lists the same tool names to every role and tells the model its role', async () => {
    const [op, orchestrator, coder] = await Promise.all([connect('operator'), connect('orchestrator'), connect('coder')])
    const names = async (client: Client) => (await client.listTools()).tools.map((tool) => tool.name).sort()
    const operatorNames = await names(op)
    expect(operatorNames).toContain('workflow_create')
    expect(operatorNames).toContain('interaction_respond')
    expect(await names(orchestrator)).toEqual(operatorNames)
    expect(await names(coder)).toEqual(operatorNames)
    expect(coder.getInstructions()).toContain('Coder role')
    expect(op.getInstructions()).toContain('Operator role')
  })

  it('describes and refuses tools outside the caller role with ROLE_NOT_ALLOWED', async () => {
    const coder = await connect('coder')
    const tools = (await coder.listTools()).tools
    const create = tools.find((tool) => tool.name === 'workflow_create')!
    expect(create.description).toMatch(/^Operator only; your Coder role cannot call this tool\./)
    expect(create.annotations).toEqual({ readOnlyHint: true })
    expect(tools.find((tool) => tool.name === 'interaction_respond')?.description).toMatch(/^Orchestrator only;/)
    expect(errorText(await coder.callTool({ name: 'workflow_create', arguments: { anything: true } })))
      .toContain('ROLE_NOT_ALLOWED')
    expect(errorText(await coder.callTool({ name: 'interaction_respond', arguments: {} })))
      .toContain('Your Coder role cannot use interaction_respond. Allowed roles: Orchestrator.')
    expect(recordDenied).toHaveBeenCalledWith('worker-1', 'mcp', 'workflow_create', 'mcp:workflow_create')
    // Its own tools keep their real, strict implementations.
    expect(tools.find((tool) => tool.name === 'interaction_get')?.inputSchema.additionalProperties).toBe(false)
  })

  it('keeps Operator management tools real and refuses Agent-only tools to the Operator', async () => {
    const op = await connect('operator')
    const tools = (await op.listTools()).tools
    expect(tools.find((tool) => tool.name === 'workflow_create')?.description).not.toMatch(/only; your/)
    expect(errorText(await op.callTool({ name: 'context_get', arguments: {} })))
      .toContain('Your Operator role cannot use context_get. Allowed roles: Orchestrator, Coder.')
    const orchestrator = await connect('orchestrator')
    const respond = (await orchestrator.listTools()).tools.find((tool) => tool.name === 'interaction_respond')!
    expect(respond.description).not.toMatch(/only; your/)
    expect(errorText(await orchestrator.callTool({ name: 'workspace_list', arguments: {} })))
      .toContain('Your Orchestrator role cannot use workspace_list. Allowed roles: Operator.')
  })
})
