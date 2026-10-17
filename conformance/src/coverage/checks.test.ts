import { describe, expect, it } from 'vitest'
import { checkBehaviorCoverage, checkHttpCoverage, checkMcpCoverage } from './checks.js'
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

  it('requires real native success for each provider separately from setup-only coverage', () => {
    const setupOnly = checkBehaviorCoverage([scenario([])])
    expect(setupOnly.missing).toContain('harness codex-native success')
    expect(setupOnly.missing).toContain('harness claude-native success')
    const codex = checkBehaviorCoverage([scenario([
      { surface: 'harness', name: 'codex-native', case: 'success' },
    ])])
    expect(codex.missing).not.toContain('harness codex-native success')
    expect(codex.missing).toContain('harness claude-native success')
  })

  it('keeps handoff and join as independent workflow requirements', () => {
    const handoff = checkBehaviorCoverage([scenario([
      { surface: 'workflow', name: 'work-handoff', case: 'success' },
    ])])
    expect(handoff.missing).not.toContain('workflow work-handoff success')
    expect(handoff.missing).toContain('workflow join success')
    expect(handoff.unexpected).toEqual([])
  })

  it('maps every HTTP requirement to declaring scenarios without treating authoring as execution', () => {
    const read = scenario([{ surface: 'http', method: 'GET', path: '/health/live', case: 'success' }])
    read.id = 'health.read'
    read.lane = 'SKEL'
    const second = { ...read, id: 'health.read-again' }
    const result = checkHttpCoverage([{ method: 'GET', path: '/health/live', lane: 'SKEL',
      transport: 'http', provenance: 'public health fixture' }], [read, second])
    expect(result.basis).toBe('authored-scenario-declarations')
    expect(result.required).toBe(2)
    expect(result.covered).toBe(1)
    expect(result.requirements).toEqual([
      { requirement: 'http GET /health/live success', lane: 'SKEL', provenance: 'public health fixture',
        scenarioIds: ['health.read', 'health.read-again'] },
      { requirement: 'http GET /health/live error', lane: 'SKEL', provenance: 'public health fixture', scenarioIds: [] },
    ])
    expect(result.declarations).toEqual([
      { requirement: 'http GET /health/live success', scenarioId: 'health.read', lane: 'SKEL' },
      { requirement: 'http GET /health/live success', scenarioId: 'health.read-again', lane: 'SKEL' },
    ])
    expect(result.groups).toEqual([{ lane: 'SKEL', provenance: 'public health fixture', required: 2, covered: 1,
      missing: ['http GET /health/live error'] }])
    expect(result.missing).toEqual(['http GET /health/live error'])
    expect(result.status).toBe('failed')
  })

  it('retains undeclared live MCP tools and identifies unexpected tool claim owners', () => {
    const result = checkMcpCoverage(['live_tool'], [scenario([
      { surface: 'mcp', tool: 'absent_tool', case: 'success' },
    ])])
    expect(result.requirements).toEqual(['success', 'denied', 'readback']
      .map(variant => ({ requirement: `live_tool ${variant}`, scenarioIds: [] })))
    expect(result.unexpected).toEqual(['absent_tool success'])
    expect(result.declarations).toEqual([
      { requirement: 'absent_tool success', scenarioId: 'workspace.lifecycle', lane: 'A2' },
    ])
    expect(result.groups).toEqual([])
  })
})
