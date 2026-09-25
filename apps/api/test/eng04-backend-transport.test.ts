import { describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { McpServer } from '@modelcontextprotocol/server'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import { registerRepeatRoutes } from '../src/routes/repeats.js'
import { registerRepeatTools } from '../src/mcp/operator/repeats.js'
import { DomainError } from '../src/modules/errors.js'

const identity = vi.hoisted(() => ({ principal: { id: 'synthetic-transport-principal' } }))
vi.mock('../src/modules/access/http.js', () => ({ requirePrincipal: () => identity.principal }))

// Adapter-only tests: the principal is synthetic. These are deliberately NOT
// evidence of browser-cookie or authenticated HTTP/MCP endpoint qualification.
type Request = { params: Record<string, string>; query: Record<string, string>; body?: unknown }
type Handler = (request: Request) => Promise<unknown>
function routes() {
  const handlers = new Map<string, Handler>()
  const app = { get(path: string, handler: Handler) { handlers.set(`GET ${path}`, handler) },
    put(path: string, handler: Handler) { handlers.set(`PUT ${path}`, handler) } } as unknown as FastifyInstance
  const save = vi.fn().mockResolvedValue({ value: { revision: 6 }, replayed: true }), run = vi.fn().mockResolvedValue({})
  registerRepeatRoutes(app, { authoring: { save, capabilities: vi.fn() } as never, readback: { run, workflow: vi.fn() } as never })
  const put = handlers.get('PUT /api/management/workspaces/:workspaceId/workflows/:workflowId/repeat')!
  const read = handlers.get('GET /api/management/workspaces/:workspaceId/workflows/:workflowId/runs/:runId/repeats')!
  const params = { workspaceId: 'workspace', workflowId: 'workflow' }
  const body = { commandId: 'repeat-command', expectedRevision: 5, expectedWorkflowVersionId: 'saved-version', executionSemanticsVersion: 3,
    repeat: { contractVersion: 1, blocks: [{ id: 'repair', nodeIds: ['work', 'review'], entryNodeId: 'work', exitNodeId: 'review',
      maxOccurrences: 3, repeatOutcome: 'issues', earlyExitOutcome: 'pass', limitExit: { kind: 'branch_end' } }] } }
  return { save, run, put, read, params, body }
}

describe('ENG04 backend HTTP/MCP transport adapters', () => {
  it('binds HTTP scope to the URL, forwards the exact command, and returns value/replayed without flattening', async () => {
    const t = routes()
    expect(await t.put({ params: t.params, query: {}, body: t.body })).toEqual({ value: { revision: 6 }, replayed: true })
    expect(t.save).toHaveBeenCalledWith(identity.principal, 'http', { ...t.body, ...t.params })
    await expect(t.put({ params: t.params, query: {}, body: { ...t.body, workflowId: 'other' } }))
      .rejects.toMatchObject({ code: 'RESOURCE_ID_MISMATCH' })
    expect(t.save).toHaveBeenCalledTimes(1)
  })
  it.each(['1', '0', 'yes', '', 'TRUE'])('rejects ambiguous HTTP includeResultData=%s rather than silently returning metadata', async (value) => {
    const t = routes()
    await expect(t.read({ params: { ...t.params, runId: 'run' }, query: { includeResultData: value } }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(t.run).not.toHaveBeenCalled()
  })
  it.each(['true', 'false'])('uses the literal HTTP includeResultData=%s flag', async (value) => {
    const t = routes()
    await t.read({ params: { ...t.params, runId: 'run' }, query: { includeResultData: value } })
    expect(t.run).toHaveBeenCalledWith(identity.principal, { ...t.params, runId: 'run', limit: 50, includeResultData: value === 'true' })
  })
  it('MCP forwards the same save shape and records a scoped denial without inventing a successful result', async () => {
    const handlers = new Map<string, (input: never) => Promise<unknown>>()
    const server = { registerTool(name: string, _definition: unknown, handler: (input: never) => Promise<unknown>) { handlers.set(name, handler) } } as unknown as McpServer
    const denied = vi.fn(), save = vi.fn().mockRejectedValue(new DomainError('ACCESS_DENIED', 'Scoped denial', 403))
    registerRepeatTools(server, { principal: identity.principal as ManagementPrincipal,
      commands: { recordDenied: denied } as never, authoring: { save, capabilities: vi.fn() } as never,
      readback: { workflow: vi.fn(), run: vi.fn() } as never, available: () => true })
    const t = routes(), input = { ...t.body, ...t.params }
    const result = await handlers.get('repeat_update')!(input as never)
    expect(save).toHaveBeenCalledWith(identity.principal, 'mcp', input)
    expect(denied).toHaveBeenCalledWith(identity.principal.id, 'mcp', 'repeat_update', 'mcp:repeat_update')
    expect(result).toMatchObject({ isError: true })
  })
})
