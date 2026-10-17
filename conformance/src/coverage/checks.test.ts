import { describe, expect, it } from 'vitest'
import { checkHttpCoverage, checkMcpCoverage } from './checks.js'
import type { CoverageClaim, Scenario } from '../scenario.js'

const scenario = (covers: CoverageClaim[]): Scenario => ({
  id: 'workspace.lifecycle', title: 'Workspace lifecycle', lane: 'A2', covers,
  run: async () => undefined,
})

describe('public surface coverage', () => {
  it('reports missing route outcomes and unexpected routes independently', () => {
    const result = checkHttpCoverage([{ method: 'GET', path: '/health/live', lane: 'SKEL',
      transport: 'http', provenance: 'unit fixture' }], [scenario([
      { surface: 'http', method: 'GET', path: '/health/live', case: 'success' },
      { surface: 'http', method: 'GET', path: '/absent', case: 'error' },
    ])])
    expect(result.status).toBe('failed')
    expect(result.missing).toEqual(['http GET /health/live error'])
    expect(result.unexpected).toEqual(['http GET /absent error'])
  })

  it('requires success, denied caller, and readback for each advertised MCP tool', () => {
    const claims: CoverageClaim[] = [
      { surface: 'mcp', tool: 'workspace_create', case: 'success' },
      { surface: 'mcp', tool: 'workspace_create', case: 'denied' },
    ]
    expect(checkMcpCoverage(['workspace_create'], [scenario(claims)]).missing)
      .toEqual(['workspace_create readback'])
    claims.push({ surface: 'mcp', tool: 'workspace_create', case: 'readback' })
    expect(checkMcpCoverage(['workspace_create'], [scenario(claims)]).status).toBe('passed')
  })

  it('fails when target discovery or the route inventory is empty', () => {
    expect(checkMcpCoverage([], []).status).toBe('failed')
    expect(checkHttpCoverage([], []).status).toBe('failed')
  })

  it('keeps main MCP and worker MCP listener coverage independent', () => {
    const routes = [
      { method: 'POST', path: '/mcp', lane: 'R' as const, transport: 'worker-mcp' as const, provenance: 'unit fixture' },
    ]
    const result = checkHttpCoverage(routes, [scenario([
      { surface: 'http', method: 'POST', path: '/mcp', case: 'success' },
      { surface: 'http', method: 'POST', path: '/mcp', case: 'error' },
    ])])
    expect(result.covered).toBe(0)
    expect(result.missing).toEqual(['worker-mcp POST /mcp error', 'worker-mcp POST /mcp success'])
  })
})
