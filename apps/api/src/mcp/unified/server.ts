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

function summary(description: string): string {
  const sentence = description.split(/(?<=\.)\s/)[0] ?? description
  // Every role receives every stub, so keep each one small.
  return sentence.length > 90 ? `${sentence.slice(0, 89)}…` : sentence
}

/** One server for every role. The caller's own tools are the existing, grant-checked
 * implementations; every other tool is listed as a stub that explains the role limit. */
export async function createGraphqlMcpServer(context: GraphqlMcpContext): Promise<McpServer> {
  const server = new McpServer({ name: 'graphql', version: '1.0.0' }, { instructions: roleInstructions(context.role) })
  const registered = new Set<string>()
  const recorder = new Proxy(server, { get(target, key) {
    if (key === 'registerTool') return (name: string, ...rest: unknown[]) => {
      registered.add(name)
      return (target.registerTool as (...args: unknown[]) => unknown).call(target, name, ...rest)
    }
    const value: unknown = Reflect.get(target, key, target)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  if (context.role === 'operator') {
    if (context.operator) registerOperatorTools(recorder, { principal: context.principal, services: context.operator })
  } else if (context.interactions) {
    await registerAppTools(recorder, { principal: context.principal, interactions: context.interactions })
  }
  const catalog = [...(context.operator ? await operatorCatalog(context.operator) : []), ...(context.interactions ? await agentCatalog() : [])]
  for (const tool of catalog) {
    const allowed = toolRoles(tool.name)
    // A tool the role may use but this credential cannot keeps its existing unlisted/audited behavior.
    if (registered.has(tool.name) || allowed.includes(context.role)) continue
    registered.add(tool.name)
    server.registerTool(tool.name, {
      description: `${roleList(allowed)} only; your ${MCP_ROLE_LABELS[context.role]} role cannot call this tool. ${summary(tool.description)}`,
      inputSchema: z.object({}).passthrough(),
      // Describes the stub itself: it only returns a denial, so harnesses need not ask for approval.
      annotations: { readOnlyHint: true },
    }, async () => {
      await context.operator?.commands.recordDenied(context.principal.id, 'mcp', tool.name, `mcp:${tool.name}`).catch(() => undefined)
      return toolFailure(new DomainError('ROLE_NOT_ALLOWED',
        `Your ${MCP_ROLE_LABELS[context.role]} role cannot use ${tool.name}. Allowed roles: ${roleList(allowed)}.`, 403,
        { role: context.role, allowedRoles: [...allowed] }))
    })
  }
  return server
}
