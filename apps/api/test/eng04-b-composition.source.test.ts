import { readFileSync, existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CurrentWorkflowSaveInputSchema, makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('ENG-S3-ONLY B wiring (source assertions, not native/PG qualification)', () => {
  it('uses one primary canonical reader without changing graph protocol or admitting native work', () => {
    const production = source('../src/production.ts')
    expect(production).toContain('new RunGraphReadService(database.pool, { qualifiedReads: true })')
    expect(production).not.toContain('createCompactSnapshotAssembler')
    expect(production).not.toContain('repeatStartPublication')
    expect(source('../src/modules/run-graph/readService.ts')).toContain('new RepeatGraphReadService(primaryPool')
  })
  it('connects both transports to the same current Save and exact manual Start services', () => {
    expect(source('../src/routes/management.ts')).toContain("services.runs.start(requirePrincipal(request), 'http', ManualRunStartInputSchema.parse(")
    expect(source('../src/mcp/operator/tools/runs.ts')).toContain("context.services.runs.start(context.principal, 'mcp', input)")
    expect(source('../src/routes/currentWorkflow.ts')).toContain("workflows.current.save(requirePrincipal(request), 'http'")
    expect(source('../src/mcp/operator/tools/currentWorkflow.ts')).toContain("context.services.workflows.current.save")
  })
  it('prepares A’s actual publisher and Stop seam without a fixture publisher or fabricated receipt', () => {
    const management = source('../src/modules/runs/management.ts')
    expect(management).toContain('production.startPublication.initializeLocked(...args)')
    expect(management).toContain('production.assertStartReady()')
    expect(management).toContain('admitRepeatRun(this.pool, this.locations, principal, source, input, publication,')
    expect(management).toContain('if (!execution.replayed)')
    expect(management).toContain('this.currentProduction!.stop(')
    expect(management).toContain('readLiveManagementPrincipal(client, principal.id)')
    expect(management).not.toContain('this.engine.cancel')
    expect(management).not.toContain('admitOneShotRun')
    expect(management).not.toContain('assertWave25Admission')
    expect(source('../src/modules/runs/currentProduction.ts')).toContain('readonly startPublication: RepeatStartPublication')
  })
  it('retires old public execution routes/registrations while preserving authenticated denial audit', () => {
    const transport = source('../src/mcp/unified/transport.ts')
    expect(transport.indexOf('await services.access.authenticate')).toBeLessThan(transport.indexOf('await retiredExecutionToolCall'))
    for (const hook of ['unavailableRunToolCall', 'unavailableCurrentWorkflowToolCall', 'unavailableRunGraphToolCall', 'unavailableRunInspectionToolCall']) {
      expect(transport).toContain(`?? await ${hook}`)
    }
    const routes = source('../src/routes/management.ts'), server = source('../src/mcp/operator/server.ts')
    expect(routes).not.toContain('services.drafts')
    expect(server).not.toContain('registerGraphTools')
    expect(server).not.toContain('registerRepeatTools')
    expect(existsSync(new URL('../src/modules/repeats/authoring.ts', import.meta.url))).toBe(false)
    expect(source('../src/routes/product.ts')).not.toContain('createForWorkflow')
    expect(source('../src/modules/workflows/postgres.ts')).not.toContain('CompatibleWorkflowVersionSchema')
  })
  it('keeps repeat absent for ordinary saves and rejects empty repeat plans and retired execution tags', () => {
    for (const form of ['single', 'repeat'] as const) {
      const fixture = makeCurrentWorkflowFixture('publication-contract', form)
      const input = {
        workspaceId: fixture.scope.workspaceId,
        workflowId: fixture.scope.workflowId,
        commandId: 'publication-command',
        executionSemanticsVersion: 3,
        expectedRevision: 1,
        expectedWorkflowVersionId: null,
        expectedAgentConfigurationVersionIds: fixture.version.agentConfigurationVersionIds,
        expectedLocationRevision: 1,
        graph: fixture.version.definition,
      }
      const parsed = CurrentWorkflowSaveInputSchema.parse(input)
      expect(parsed.graph).toEqual(fixture.version.definition)
      expect(Object.hasOwn(parsed.graph, 'repeat')).toBe(form === 'repeat')
      expect(CurrentWorkflowSaveInputSchema.safeParse({
        ...input, graph: { ...input.graph, repeat: { blocks: [] } },
      }).success).toBe(false)
      for (const executionSemanticsVersion of [1, 2, 4]) {
        expect(CurrentWorkflowSaveInputSchema.safeParse({ ...input, executionSemanticsVersion }).success).toBe(false)
        expect(CurrentWorkflowSaveInputSchema.safeParse({
          ...input, graph: { ...input.graph, executionSemanticsVersion },
        }).success).toBe(false)
      }
    }
  })
})
