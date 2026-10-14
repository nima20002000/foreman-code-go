import { MCP_DISPLAY_NAME, PRODUCT_SLUG } from '@foreman-code/contracts/product'
import { McpServer } from '@modelcontextprotocol/server'
import { paginateToolLists } from '../toolListPagination.js'
import { ManagementActionSchema, type ManagementPrincipal } from '@foreman-code/contracts/management'
import { z } from 'zod'
import { GRAPHQL_AGENT_TOOLS } from '@foreman-code/contracts'

import { DomainError } from '../../modules/errors.js'
import { hasWorkerAction } from '../../modules/access/appPolicy.js'
import type { AppInteractionService } from '../../modules/interactions/app.js'
import type { BugReportService } from '../../modules/bug-reports/service.js'
import type { PostgresCommandCoordinator } from '../../modules/commands/postgres.js'
import { registerAppTools } from '../app/server.js'
import { registerCiTools } from '../shared/ciTools.js'
import { registerOperatorTools } from '../operator/server.js'
import { installOperatorPresentation, type OperatorCatalog } from '../operator/presentation.js'
import type { OperatorServices } from '../operator/types.js'
import { toolFailure } from '../shared/results.js'
import { cacheToolSchemaConversions } from '../shared/schemaCache.js'
import { stripMcpInputSchemas } from '../shared/inputSchemas.js'
import { retryReadOnlyToolConnections } from '../shared/databaseReadRetry.js'
import { MCP_ROLE_LABELS, roleInstructions, roleList, toolRoles, type McpRole } from './roles.js'

export interface GraphqlMcpContext {
  role: McpRole
  principal: ManagementPrincipal
  operator?: OperatorServices
  interactions?: AppInteractionService
  bugReports?: BugReportService
  commands?: PostgresCommandCoordinator
  /** Worker roles only: the tools enabled for this Agent's configuration and workflow node. */
  tools?: readonly string[]
  signal?: AbortSignal
}

interface ToolDefinition {
  name: string
  description: string
  register(server: McpServer): void
}

/** Records every registerTool call. Handlers are never invoked while collecting. */
async function collectTools(register: (server: McpServer) => unknown): Promise<ToolDefinition[]> {
  const tools: ToolDefinition[] = []
  const collector = { registerTool: (name: string, config: { description?: string }, ...rest: unknown[]) => {
    tools.push({ name, description: config.description ?? '', register(server) {
      Reflect.apply(server.registerTool, server, [name, config, ...rest])
    } })
  } } as unknown as McpServer
  await register(collector)
  return tools
}

const CATALOG_PRINCIPAL: ManagementPrincipal = {
  id: 'graphql-mcp-catalog', name: 'Foreman Code MCP catalog', audience: 'operator',
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
function agentCatalog(): Array<{ name: string; description: string }> {
  return Object.entries(GRAPHQL_AGENT_TOOLS).map(([name, definition]) => ({ name, description: definition.description }))
}

interface OperatorRequestTools {
  tools: ToolDefinition[]
  catalog?: OperatorCatalog
}
export interface McpRequestRegistration {
  operator?: Promise<OperatorRequestTools>
}

/** Definitions and handlers live for one request, including its current grants. */
function requestOperatorTools(context: GraphqlMcpContext, registration: McpRequestRegistration): Promise<OperatorRequestTools> {
  let pending = registration.operator
  if (!pending) {
    const registered: OperatorRequestTools = { tools: [] }
    pending = collectTools(server => registerOperatorTools(server, {
      principal: context.principal, services: context.operator!,
      ...(context.signal ? { signal: context.signal } : {}),
    }, callbackContext => registered.catalog?.(callbackContext) ?? Promise.resolve([])))
      .then(tools => {
        registered.tools = tools
        return registered
      })
    registration.operator = pending
  }
  return pending
}

const ToolCall = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number().int()]),
  method: z.literal('tools/call'), params: z.object({ name: z.string() }).passthrough() }).passthrough()

/** Known tools hidden by role, Agent configuration or Operator grants still receive an audited denial. */
export async function roleDeniedToolCall(context: GraphqlMcpContext, body: unknown,
  registration: McpRequestRegistration = {}) {
  const call = ToolCall.safeParse(body)
  if (!call.success) return undefined
  const name = call.data.params.name
  const allowed = toolRoles(name)
  const enabled = name === 'bug_report' || !context.tools || context.tools.includes(name)
  const roleAllowed = allowed.includes(context.role)
  const workerReportDenied = context.role !== 'operator' && name === 'bug_report'
    && !hasWorkerAction(context.principal, 'bug_reports:report')
  if (roleAllowed && enabled && context.role !== 'operator' && !workerReportDenied) return undefined
  const catalog = [
    ...(context.operator ? await operatorCatalog(context.operator) : []),
    ...(context.interactions ? await agentCatalog() : []),
  ]
  if (!catalog.some((tool) => tool.name === name)) return undefined
  let error: DomainError
  if (workerReportDenied) {
    error = new DomainError('ACCESS_DENIED', 'The caller is not authorized to report bugs in this execution.', 403)
  } else if (roleAllowed && enabled) {
    const services = context.operator
    if (!services) return undefined
    const available = await requestOperatorTools(context, registration)
    if (available.tools.some((tool) => tool.name === name)) return undefined
    error = new DomainError('ACCESS_DENIED', 'The caller is not authorized for this operation and resource.', 403)
  } else if (roleAllowed) {
    error = new DomainError('TOOL_NOT_ENABLED',
      `This Agent does not have ${name} enabled in its Foreman Code MCP tools. Enabled: ${context.tools!.join(', ') || 'none'}.`, 403,
      { enabledTools: [...context.tools!] })
  } else {
    error = new DomainError('ROLE_NOT_ALLOWED',
      `Your ${MCP_ROLE_LABELS[context.role]} role cannot use ${name}. Allowed roles: ${roleList(allowed)}.`, 403,
      { role: context.role, allowedRoles: [...allowed] })
  }
  const commands = context.commands ?? context.operator?.commands
  await commands?.recordDenied(context.principal.id, 'mcp', name, `mcp:${name}`)
  return { jsonrpc: '2.0' as const, id: call.data.id, result: toolFailure(error) }
}

/** One server for every role. Each caller lists only its enabled tools: the existing, grant-checked implementations. */
export async function createGraphqlMcpServer(context: GraphqlMcpContext, requestBody?: unknown,
  registration: McpRequestRegistration = {}): Promise<McpServer> {
  const call = ToolCall.safeParse(requestBody)
  const requestedTool = call.success && call.data.params.name !== 'operator_tool_schema_get'
    && call.data.params.name !== 'operator_get_capabilities'
    ? call.data.params.name : undefined
  const server = new McpServer({ name: PRODUCT_SLUG, title: MCP_DISPLAY_NAME, version: '1.0.0' }, { instructions: roleInstructions(context.role) })
  cacheToolSchemaConversions(server, 'unified')
  stripMcpInputSchemas(server)
  retryReadOnlyToolConnections(server)
  paginateToolLists(server)
  if (context.role === 'operator') {
    if (context.operator) {
      const registered = await requestOperatorTools(context, registration)
      registered.catalog = installOperatorPresentation(server)
      const selected = requestedTool !== undefined && registered.tools.some(tool => tool.name === requestedTool)
      for (const tool of registered.tools) {
        if (!selected || tool.name === requestedTool) tool.register(server)
      }
    }
  } else if (context.interactions) {
    const tools = context.tools
    // Registers only the tools enabled for this Agent; the rest are never listed.
    const enabled = tools ? new Proxy(server, { get(target, key) {
      if (key === 'registerTool') return (name: string, ...rest: unknown[]) => name === 'bug_report' || tools.includes(name)
        ? (target.registerTool as (...args: unknown[]) => unknown).call(target, name, ...rest) : undefined
      const value: unknown = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    } }) : server
    await registerAppTools(enabled, { principal: context.principal, interactions: context.interactions,
      ...(context.bugReports ? { bugReports: context.bugReports } : {}),
      ...(context.signal ? { signal: context.signal } : {}) })
    if (context.operator) registerCiTools(enabled, { principal: context.principal, services: context.operator,
      ...(context.signal ? { signal: context.signal } : {}) })
  }
  return server
}
