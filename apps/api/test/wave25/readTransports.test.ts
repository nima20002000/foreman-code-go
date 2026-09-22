import { describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import type pg from 'pg'
import type { McpServer } from '@modelcontextprotocol/server'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import { DISABLED_RUN_GRAPH_CAPABILITIES, RUN_GRAPH_MCP_TOOLS, makeWave25Fixture } from '@graphql/contracts/wave25'
import { registerRunGraphRoutes } from '../../src/routes/runGraph.js'
import { registerRunGraphTools } from '../../src/mcp/operator/tools/runGraph.js'
import type { OperatorRequestContext } from '../../src/mcp/operator/types.js'
import { RunGraphReadService, type RunGraphReadApi } from '../../src/modules/run-graph/readService.js'
import { RunGraphError } from '../../src/modules/run-graph/errors.js'

const fixture = makeWave25Fixture('a5-transport')
const principal: ManagementPrincipal = { id: 'reader', name: 'Reader', audience: 'operator', expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null,
  grants: [{ actions: ['runs:read'], scope: { workspaceIds: [fixture.scope.workspaceId] } }] }
const snapshotPath = `/api/workspaces/${fixture.scope.workspaceId}/workflows/${fixture.scope.workflowId}/runs/${fixture.scope.runId}/graph/v1/snapshot`
const query = `workflowVersionId=${fixture.scope.workflowVersionId}&executionSemanticsVersion=2`
function stubReads(): RunGraphReadApi {
  return { capabilities: () => DISABLED_RUN_GRAPH_CAPABILITIES, snapshot: vi.fn(async () => fixture.snapshot),
    events: vi.fn(async () => ({ kind: 'page' as const, protocolVersion: 1 as const, scope: fixture.scope,
      baseSequence: '9007199254740993', throughSequence: '9007199254740993', headSequence: '9007199254740993', retentionFloor: '0', hasMore: false, batches: [] })) }
}

/** Transport wiring tests. The synthetic principal hook is NOT a bearer/cookie authentication qualification. */
describe('A5 HTTP graph adapters', () => {
  it('passes the authenticated principal and exact pins to the shared service with no-store headers', async () => {
    const app = Fastify(), reads = stubReads(), audit = vi.fn(async () => undefined)
    app.addHook('onRequest', async (request) => { request.operatorPrincipal = principal })
    registerRunGraphRoutes(app, reads, audit)
    try {
      const result = await app.inject({ method: 'GET', url: `${snapshotPath}?${query}` })
      expect(result.statusCode).toBe(200); expect(result.json()).toEqual(fixture.snapshot)
      expect(result.headers['cache-control']).toContain('no-store')
      expect(reads.snapshot).toHaveBeenCalledWith(principal, { protocolVersion: 1, scope: fixture.scope })
      expect(audit).not.toHaveBeenCalled()
    } finally { await app.close() }
  })
  it('never calls the reader for an anonymous request and records a safe denial', async () => {
    const app = Fastify(), reads = stubReads(), audit = vi.fn(async () => undefined)
    registerRunGraphRoutes(app, reads, audit)
    try {
      const result = await app.inject({ method: 'GET', url: `${snapshotPath}?${query}` })
      expect(result.statusCode).toBe(403); expect(result.json().error.code).toBe('GRAPH_READ_ACCESS_DENIED')
      expect(reads.snapshot).not.toHaveBeenCalled(); expect(audit).toHaveBeenCalledTimes(1)
    } finally { await app.close() }
  })
  it('preserves cursor precision, rejects ambiguous cursors, and safely returns service denials', async () => {
    const app = Fastify(), reads = stubReads(), audit = vi.fn(async () => undefined)
    app.addHook('onRequest', async (request) => { request.operatorPrincipal = principal })
    registerRunGraphRoutes(app, reads, audit)
    try {
      const path = snapshotPath.replace('/snapshot', '/events')
      const result = await app.inject({ method: 'GET', url: `${path}?${query}&afterSequence=9007199254740993` })
      expect(result.statusCode).toBe(200)
      expect(reads.events).toHaveBeenCalledWith(principal, { protocolVersion: 1, scope: fixture.scope, afterSequence: '9007199254740993' })
      expect((await app.inject({ method: 'GET', url: `${path}?${query}&afterSequence=01` })).json().error.code).toBe('GRAPH_INVALID_CURSOR')
      reads.snapshot = async () => { throw new RunGraphError('GRAPH_READ_ACCESS_DENIED') }
      expect((await app.inject({ method: 'GET', url: `${snapshotPath}?${query}` })).statusCode).toBe(403)
      reads.snapshot = async () => { throw new Error('/private/SECRET-PROBE') }
      expect((await app.inject({ method: 'GET', url: `${snapshotPath}?${query}` })).body).not.toContain('SECRET-PROBE')
    } finally { await app.close() }
  })
})

describe('A5 Operator extension callbacks', () => {
  it('registers versioned read-only tools, forwards identical requests and audits denied calls', async () => {
    type Result = { content: { text: string }[]; structuredContent?: unknown; isError?: boolean }
    const tools = new Map<string, { annotations: Record<string, boolean>; call: (input: unknown) => Promise<Result> }>()
    // Registration double only. Actual SDK framing/output validation is a separate qualification check.
    const server = { registerTool(name: string, definition: { annotations: Record<string, boolean> }, call: (input: unknown) => Promise<Result>) {
      tools.set(name, { annotations: definition.annotations, call })
    } } as unknown as McpServer
    const audit = vi.fn(async () => undefined)
    const context = { principal, services: { commands: { recordDenied: audit } } } as unknown as OperatorRequestContext
    const reads = stubReads()
    registerRunGraphTools(server, context, reads)
    expect([...tools.keys()].sort()).toEqual(Object.values(RUN_GRAPH_MCP_TOOLS).sort())
    for (const tool of tools.values()) expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false })
    const input = { protocolVersion: 1, scope: fixture.scope }
    expect((await tools.get(RUN_GRAPH_MCP_TOOLS.snapshot)!.call(input)).structuredContent).toEqual(fixture.snapshot)
    expect(reads.snapshot).toHaveBeenCalledWith(principal, input)
    reads.snapshot = async () => { throw new RunGraphError('GRAPH_READ_ACCESS_DENIED') }
    const denied = await tools.get(RUN_GRAPH_MCP_TOOLS.snapshot)!.call(input)
    expect(denied.isError).toBe(true); expect(JSON.parse(denied.content[0]!.text).error.code).toBe('GRAPH_READ_ACCESS_DENIED')
    expect(audit).toHaveBeenCalledTimes(1)
    reads.snapshot = async () => { throw new Error('/private/SECRET-PROBE') }
    expect(JSON.stringify(await tools.get(RUN_GRAPH_MCP_TOOLS.snapshot)!.call(input))).not.toContain('SECRET-PROBE')
  })
  it('keeps reads and admission disabled by default; App, expired and revoked principals cannot discover capabilities', async () => {
    const pool = {} as pg.Pool
    const service = new RunGraphReadService(pool, async () => { throw new Error('Disabled reader must not query') })
    expect(service.capabilities(principal)).toEqual(DISABLED_RUN_GRAPH_CAPABILITIES)
    await expect(service.snapshot(principal, { protocolVersion: 1, scope: fixture.scope })).rejects.toMatchObject({ code: 'GRAPH_NOT_INITIALIZED' })
    for (const denied of [{ ...principal, audience: 'worker' as const, agentId: 'agent' },
      { ...principal, expiresAt: '2000-01-01T00:00:00.000Z' }, { ...principal, revokedAt: '2026-01-01T00:00:00.000Z' }]) {
      expect(() => service.capabilities(denied)).toThrow('GRAPH_READ_ACCESS_DENIED')
    }
    const qualified = new RunGraphReadService(pool, async () => { throw new Error('Unused assembler') }, { qualifiedReads: true })
    expect(qualified.capabilities(principal)).toMatchObject({ admissionEnabled: false, authoringSemanticsVersions: [], protocolVersions: [1] })
  })
})
