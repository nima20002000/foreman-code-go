import { describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import { ZodError } from 'zod'
import type pg from 'pg'
import type { McpServer } from '@modelcontextprotocol/server'
import { RUN_CURRENT_MCP_TOOL, RunCurrentRequestSchema, RunCurrentResponseSchema } from '@graphql/contracts/run-current'
import { DomainError } from '../src/modules/errors.js'
import { registerOperatorHttpSecurity } from '../src/modules/access/http.js'
import type { PostgresAccessService } from '../src/modules/access/postgres.js'
import { RunManagementService } from '../src/modules/runs/management.js'
import { registerManagementRoutes } from '../src/routes/management.js'
import { registerRunTools } from '../src/mcp/operator/tools/runs.js'
import type { OperatorRequestContext, OperatorServices } from '../src/mcp/operator/types.js'
import { currentPrincipal, currentRow, currentScope } from './helpers/feR2001Current.js'

// In-process adapter tests. Authentication is a test credential resolver, not
// evidence of real browser login, persisted grants or an MCP network session.
function services() {
  const query = vi.fn(async (sql: string) => sql.includes('select sequence::text, source') ? { rows: [{
    sequence: '1', source: 'backend', kind: 'run_state_changed', harness_execution_id: null,
    occurred_at: new Date('2026-09-22T00:00:00.000Z'), payload: {},
  }] } : { rows: [currentRow()] })
  type Args = ConstructorParameters<typeof RunManagementService>
  const getDetails = vi.fn()
  const runs = new RunManagementService({ query } as unknown as pg.Pool, {} as Args[1], {
    getForWorkspace: async () => currentRow().run, getDetails,
  } as unknown as Args[2], {} as Args[3], {} as Args[4])
  const recordDenied = vi.fn(async () => undefined)
  const service = { runs, commands: { recordDenied } } as unknown as OperatorServices
  return { service, query, getDetails, recordDenied }
}
function tools(context: OperatorRequestContext) {
  const registered = new Map<string, { definition: Record<string, unknown>; invoke: (input: unknown) => Promise<unknown> }>()
  const server = { registerTool(name: string, definition: Record<string, unknown>, invoke: (input: unknown) => Promise<unknown>) {
    registered.set(name, { definition, invoke })
  } } as unknown as McpServer
  registerRunTools(server, context)
  return registered
}
const currentUrl = () => `/api/management/workspaces/${currentScope.workspaceId}/runs/${currentScope.runId}/current?${new URLSearchParams({
  workflowId: currentScope.workflowId, workflowVersionId: currentScope.workflowVersionId, executionSemanticsVersion: '1',
})}`

describe('FE-R2-001 HTTP/MCP shared read boundaries', () => {
  it('uses the actual authenticated HTTP route and same current service/schema as the versioned MCP tool', async () => {
    const f = services()
    let principal = currentPrincipal()
    const app = Fastify()
    app.setErrorHandler((error, _request, reply) => {
      const status = error instanceof DomainError ? error.status : error instanceof ZodError ? 400 : 500
      return reply.code(status).send({ error: { code: error instanceof DomainError ? error.code : 'INVALID_INPUT', message: 'Request rejected' } })
    })
    registerOperatorHttpSecurity(app, { authenticate: async (token: string | undefined) => {
      if (token !== 'fe-r2-test-credential') throw new DomainError('AUTH_REQUIRED', 'Test credential required', 401)
      return principal
    } } as unknown as PostgresAccessService)
    registerManagementRoutes(app, f.service)
    try {
      const headers = { authorization: 'Bearer fe-r2-test-credential' }
      const response = await app.inject({ method: 'GET', url: currentUrl(), headers })
      expect(response.statusCode).toBe(200)
      const current = RunCurrentResponseSchema.parse(response.json())
      expect(current.history).toBe('not-included')
      expect(response.headers['cache-control']).toBe('no-store')
      expect(f.query).toHaveBeenCalledTimes(1)
      expect(f.getDetails).not.toHaveBeenCalled()
      const registry = tools({ principal, services: f.service })
      const tool = registry.get(RUN_CURRENT_MCP_TOOL)!
      expect(tool.definition.inputSchema).toBe(RunCurrentRequestSchema)
      expect(tool.definition.outputSchema).toBe(RunCurrentResponseSchema)
      const mcp = await tool.invoke(currentScope) as { structuredContent: unknown }
      expect(RunCurrentResponseSchema.parse(mcp.structuredContent)).toEqual(current)

      const history = await app.inject({ method: 'GET', headers,
        url: `/api/management/workspaces/${currentScope.workspaceId}/runs/${currentScope.runId}/events?limit=50` })
      expect(history.statusCode).toBe(200)
      expect(history.json().items).toHaveLength(1)
      expect(f.query.mock.calls.at(-1)?.[0]).toMatch(/order by run_activity\.sequence limit \$3/)

      const calls = f.query.mock.calls.length
      expect((await app.inject({ method: 'GET', url: currentUrl() })).statusCode).toBe(401)
      expect((await app.inject({ method: 'GET', headers, url: currentUrl().replace('executionSemanticsVersion=1', 'executionSemanticsVersion=2') })).statusCode).toBe(400)
      principal = currentPrincipal(false)
      expect((await app.inject({ method: 'GET', headers, url: currentUrl() })).statusCode).toBe(403)
      expect(f.query).toHaveBeenCalledTimes(calls)
    } finally { await app.close() }
  })
  it('keeps discovery action parity and enforces/audits scope denial on direct MCP invocation', async () => {
    const f = services()
    expect(tools({ principal: currentPrincipal(false), services: f.service }).has(RUN_CURRENT_MCP_TOOL)).toBe(false)
    const context = { principal: currentPrincipal(), services: f.service }
    const tool = tools(context).get(RUN_CURRENT_MCP_TOOL)!
    const result = await tool.invoke({ ...currentScope, workflowId: 'foreign-workflow' }) as { isError: boolean }
    expect(result.isError).toBe(true)
    expect(f.query).not.toHaveBeenCalled()
    expect(f.recordDenied).toHaveBeenCalledWith(context.principal.id, 'mcp', RUN_CURRENT_MCP_TOOL, `mcp:${RUN_CURRENT_MCP_TOOL}`)
  })
})
