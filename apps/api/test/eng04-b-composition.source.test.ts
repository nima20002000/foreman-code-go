import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('ENG04-B source composition fences (not native or PostgreSQL qualification)', () => {
  it('qualifies the existing primary-pool reader without configuring native admission', () => {
    const production = source('../src/production.ts')
    expect(production).toMatch(/new RunGraphReadService\(database\.pool,[\s\S]*?qualifiedReads: true, qualifiedRepeatReads: true/)
    expect(production).not.toContain('new RepeatGraphReadService(')
    expect(production).not.toContain('repeatStartPublication')
    const service = source('../src/modules/run-graph/readService.ts')
    expect(service).toMatch(/new RepeatGraphReadService\(primaryPool,\s*\{\s*qualifiedReads: options\.qualifiedRepeatReads === true/)
  })

  it('makes HTTP and MCP share the strict manual Start schema and same domain service', () => {
    expect(source('../src/routes/management.ts')).toContain("services.runs.start(requirePrincipal(request), 'http', ManualRunStartInputSchema.parse(")
    const mcp = source('../src/mcp/operator/tools/runs.ts')
    expect(mcp).toContain('inputSchema: ManualRunStartInputSchema')
    expect(mcp).toContain('outputSchema: ManualRunStartResultSchema')
    expect(mcp).toContain("context.services.runs.start(context.principal, 'mcp', input)")
    expect(source('../src/modules/runs/management.ts')).toContain('RunStartV3InputSchema.parse(command), undefined,')
  })

  it('keeps public v3 Stop closed before terminal/cleanup paths and checks live authority before receipt replay', () => {
    const stop = source('../src/modules/runs/management.ts').split('  async stop(')[1]!
    expect(stop.indexOf('authorize: async (client)')).toBeGreaterThan(0)
    expect(stop.indexOf('authorize: async (client)')).toBeLessThan(stop.indexOf('perform: async (client)'))
    expect(stop).toContain('readLiveManagementPrincipal(client, principal.id)')
    const gate = stop.indexOf("throw new DomainError('REPEAT_STOP_RUNTIME_UNAVAILABLE'")
    expect(gate).toBeGreaterThan(0)
    expect(gate).toBeLessThan(stop.indexOf("latest.executionState === 'completed'"))
    expect(gate).toBeLessThan(stop.indexOf('this.engine.cancel'))
    expect(stop).toContain('if (!repeatReplay &&')
  })

  it('audits hidden manual Run invocations only after the existing Operator authentication', () => {
    const transport = source('../src/mcp/operator/transport.ts')
    expect(transport.indexOf('await access.authenticate')).toBeLessThan(transport.indexOf('?? await unavailableManualRunToolCall'))
    expect(transport).toContain('if (unavailable) return reply.send(unavailable)')
    const tools = source('../src/mcp/operator/tools/runs.ts')
    expect(tools).toContain("z.enum(['run_start', 'run_stop'])")
    expect(tools).toContain('operatorToolAvailable(context, request.data.params.name)')
    expect(tools).toContain("context.services.commands.recordDenied(context.principal.id, 'mcp', name, `mcp:${name}`)")
  })
})
