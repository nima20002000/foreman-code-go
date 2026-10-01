import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('NIM-2648 ENG04-D active execution-semantics retirement source guard', () => {
  it('keeps the current save/read/Start contracts V3-only and makes repeat optional instead of projecting through V2', () => {
    const repeat = source('../../../packages/contracts/src/wave25/repeat.ts')
    const shape = source('../../../packages/contracts/src/wave25/workflowShape.ts')
    const saved = source('../../../packages/contracts/src/wave25/saved.ts')
    const admission = source('../../../packages/contracts/src/wave25/repeatAdmission.ts')

    expect(repeat).not.toContain('WorkflowVersionV2Schema.safeParse')
    expect(repeat).not.toContain('ExecutableWorkflowV2Schema.safeParse')
    expect(shape).toMatch(/repeat:\s*RepeatPlanV1Schema\.optional\(\)/)
    expect(repeat).toContain('definition: WorkflowDefinitionV3Schema')
    expect(saved).not.toContain('WorkflowVersionV2Schema')
    expect(saved).not.toContain('WorkflowRunV2Schema')
    expect(admission).not.toContain('RunStartV2InputSchema')
    expect(admission).not.toMatch(/ManualRunStartInputSchema\s*=\s*z\.union/)
  })

  it('uses one real production V3 Start/runtime publisher without one-shot or legacy execution dispatch', () => {
    const management = source('../src/modules/runs/management.ts')
    const engine = source('../src/modules/runs/engine.ts')
    const production = source('../src/production.ts')

    expect(management).not.toContain('admitOneShotRun')
    expect(management).not.toContain('assertWave25Admission')
    expect(management).not.toContain('executionSemanticsVersion === 2')
    expect(engine).not.toContain('executeOneShotRuntime')
    expect(engine).not.toContain('isOneShotRun')
    expect(engine).not.toContain('WorkflowVersionV2Schema')
    expect(production).toContain('createCurrentNativeProductionFactory')
    expect(source('../src/modules/runs/workflowProduction.ts')).toContain('startPublication: repeatStartPublication')
    expect(management).not.toContain('RunStartV3InputSchema.parse(command), undefined')
  })

  it('keeps authenticated HTTP and Operator MCP on the same current Run service and V3-only manual Start schema', () => {
    const routes = source('../src/routes/management.ts')
    const mcp = source('../src/mcp/operator/tools/runs.ts')
    const admission = source('../../../packages/contracts/src/wave25/repeatAdmission.ts')

    expect(routes).toContain("services.runs.start(requirePrincipal(request), 'http'")
    expect(mcp).toContain("context.services.runs.start(context.principal, 'mcp', input)")
    expect(admission).not.toMatch(/\bRunStartInputSchema\b/)
    expect(admission).not.toContain('RunStartV2InputSchema')
  })

  it('keeps the mounted Board on current V3 run/read state and treats repeat as optional V3 authoring state', () => {
    const board = source('../../web/src/features/workflow-board/client.ts')
    expect(existsSync(new URL('../../web/src/features/repeats/useRepeatAuthoring.ts', import.meta.url))).toBe(false)

    expect(board).not.toContain('CompatibleRunDetailsSchema')
    expect(board).not.toMatch(/executionSemanticsVersion[^\n]+:\s*1/)
    expect(board).toContain('CurrentRunDetailsSchema')
    expect(board).toContain('RepeatGraphScopeV3Schema.parse')
  })

  it('uses the same verified current cut for V3 snapshot and complete delta and keeps production reads qualified', () => {
    const reader = source('../src/modules/run-graph/repeatReader.ts')
    const production = source('../src/production.ts')

    const uses = reader.match(/verifiedRepeatCut\(/g)?.length ?? 0
    expect(uses).toBeGreaterThanOrEqual(3)
    expect(reader).toContain('readRepeatGraphSnapshot')
    expect(reader).toContain('readRepeatGraphPage')
    expect(production).toMatch(/new RunGraphReadService\(database.pool,\s*\{ qualifiedReads: true \}\)/)
    expect(source('../src/modules/run-graph/readService.ts')).toContain('new RepeatGraphReadService')
  })

  it('flags compatibility-only PostgreSQL fixtures until the gate retires them rather than treating them as current positives', () => {
    const migration = source('./eng04-migration-postgres.integration.test.ts')
    const fixtures = source('./eng04-migration-fixtures.ts')
    const migrationStatic = source('./eng04-migration-static.test.ts')

    expect(migration).not.toMatch(/forward-v1|forward-v2|legacyReplay|scope-legacy|rollback-legacy|legacy-key/)
    expect(fixtures).not.toContain('semantics: 1 | 2 | 3')
    expect(fixtures).not.toContain('installLegacy')
    expect(fixtures).not.toContain('legacyReplay')
    expect(migrationStatic).not.toContain('check (execution_semantics_version in (1,2,3))')
  })
})
