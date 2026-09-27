import { McpServer } from '@modelcontextprotocol/server'
import { ManagementActionSchema, type ManagementPrincipal } from '@graphql/contracts/management'
import { z } from 'zod'

import { DomainError } from '../../modules/errors.js'
import type { AppInteractionService } from '../../modules/interactions/app.js'
import { registerAppTools } from '../app/server.js'
import { registerOperatorTools } from '../operator/server.js'
import type { OperatorServices } from '../operator/types.js'
import { toolFailure } from '../shared/results.js'
import { MCP_ROLE_LABELS, roleInstructions, roleList, toolRoles, type McpRole } from './roles.js'

export interface GraphqlMcpContext {
  role: McpRole
  principal: ManagementPrincipal
  operator?: OperatorServices
  interactions?: AppInteractionService
}

interface ToolDefinition { name: string; description: string }

/** Records every registerTool call. Handlers are never invoked while collecting. */
async function collectTools(register: (server: McpServer) => unknown): Promise<ToolDefinition[]> {
  const tools: ToolDefinition[] = []
  const collector = { registerTool: (name: string, config: { description?: string }) => {
    tools.push({ name, description: config.description ?? '' })
  } } as unknown as McpServer
  await register(collector)
  return tools
}

const CATALOG_PRINCIPAL: ManagementPrincipal = {
  id: 'graphql-mcp-catalog', name: 'GraphQL MCP catalog', audience: 'operator',
  grants: [{ actions: [...ManagementActionSchema.options], scope: {} }],
  expiresAt: '9999-12-31T00:00:00.000Z', revokedAt: null,
}
const operatorCatalogs = new WeakMap<OperatorServices, Promise<ToolDefinition[]>>()
/** Every Operator tool these services can serve, as an unrestricted Operator would see it. */
function operatorCatalog(services: OperatorServices): Promise<ToolDefinition[]> {
  let catalog = operatorCatalogs.get(services)
  if (!catalog) {
    catalog = collectTools((server) => registerOperatorTools(server, { principal: CATALOG_PRINCIPAL, services }))
    operatorCatalogs.set(services, catalog)
  }
  return catalog
}
let appCatalog: Promise<ToolDefinition[]> | undefined
function agentCatalog(): Promise<ToolDefinition[]> {
  const everything = { canRead: async () => true, canRespond: async () => true } as unknown as AppInteractionService
  appCatalog ??= collectTools((server) => registerAppTools(server, { principal: CATALOG_PRINCIPAL, interactions: everything }))
  return appCatalog
}

const ToolCall = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number().int()]),
  method: z.literal('tools/call'), params: z.object({ name: z.string() }).passthrough() }).passthrough()

/** Tools outside the caller's role are not listed. A direct call to one still gets an audited,
 * explicit ROLE_NOT_ALLOWED instead of the SDK's generic unknown-tool response. */
export async function roleDeniedToolCall(context: GraphqlMcpContext, body: unknown) {
  const call = ToolCall.safeParse(body)
  if (!call.success) return undefined
  const name = call.data.params.name
  const allowed = toolRoles(name)
  if (allowed.includes(context.role)) return undefined
  const catalog = [...(context.operator ? await operatorCatalog(context.operator) : []), ...(context.interactions ? await agentCatalog() : [])]
  if (!catalog.some((tool) => tool.name === name)) return undefined
  await context.operator?.commands.recordDenied(context.principal.id, 'mcp', name, `mcp:${name}`).catch(() => undefined)
  return { jsonrpc: '2.0' as const, id: call.data.id, result: toolFailure(new DomainError('ROLE_NOT_ALLOWED',
    `Your ${MCP_ROLE_LABELS[context.role]} role cannot use ${name}. Allowed roles: ${roleList(allowed)}.`, 403,
    { role: context.role, allowedRoles: [...allowed] })) }
}

/** One server for every role. Each role lists only its own tools: the existing, grant-checked implementations. */
export async function createGraphqlMcpServer(context: GraphqlMcpContext): Promise<McpServer> {
  const server = new McpServer({ name: 'graphql', version: '1.0.0' }, { instructions: roleInstructions(context.role) })
  if (context.role === 'operator') {
    if (context.operator) registerOperatorTools(server, { principal: context.principal, services: context.operator })
  } else if (context.interactions) {
    await registerAppTools(server, { principal: context.principal, interactions: context.interactions })
  }
  return server
}
