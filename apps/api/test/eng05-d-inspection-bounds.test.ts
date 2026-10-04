import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import {
  RUN_INSPECTION_LIMITS, RunAcceptedInputValueSchema, RunExecutionDetailSchema,
  RunExecutionBindingsPageSchema, RunExecutionBindingSchema, RunExecutionsPageSchema,
  RunExecutionsListInputSchema, RunInputSourceSchema, makeCurrentWorkflowFixture,
} from '@foreman-code/contracts/wave25'
import { inspectionExecutionsQuery } from '../src/modules/runs/inspectionPageQuery.js'
import { decodeExecutionPageCursor, encodeExecutionPageCursor } from '../src/modules/runs/inspectionCursor.js'

const f = makeCurrentWorkflowFixture('eng05-d-byte-bounds', 'single')
const metadata = { ...f.scope, executionState: 'completed' as const, outcome: 'failed' as const,
  createdAt: f.createdAt, finishedAt: f.createdAt, cleanupPending: false }
const summary = { ...f.identities[0]!, state: 'completed' as const, createdAt: f.createdAt, finishedAt: f.createdAt, acceptedResultAvailable: false }
const digest = `sha256:${'1'.repeat(64)}`
const emptyInput = { executionSemanticsVersion: 3 as const, runInput: {}, occurrence: null, entry: null, predecessors: [] }
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8')

describe('ENG05-D inspection byte and row budgets', () => {
  it('rejects a UTF-8 input over 4 MiB even when its JavaScript character count is below the bound', () => {
    // Schema-size fixtures only, not persisted runs or accepted native evidence.
    // Each source has a distinct identity and an individually bounded result.
    const source = (index: number) => RunInputSourceSchema.parse({ relationshipId: `source-edge-${index}`,
      execution: { ...f.identities[0], executionId: `source-execution-${index}` }, occurrence: null,
      acceptedResultDigest: digest, acceptedResult: { outcome: 'succeeded', output: { text: '🙂'.repeat(12_000) } } })
    const under = { ...emptyInput, predecessors: Array.from({ length: 80 }, (_, index) => source(index)) }
    const over = { ...emptyInput, predecessors: Array.from({ length: 90 }, (_, index) => source(index)) }
    expect(bytes(under)).toBeLessThan(RUN_INSPECTION_LIMITS.inputBytes)
    expect(RunAcceptedInputValueSchema.parse(under)).toEqual(under)
    expect(JSON.stringify(over).length).toBeLessThan(RUN_INSPECTION_LIMITS.inputBytes)
    expect(bytes(over)).toBeGreaterThan(RUN_INSPECTION_LIMITS.inputBytes)
    expect(RunAcceptedInputValueSchema.safeParse(over).success).toBe(false)
    expect(over.predecessors).toHaveLength(90) // no mutation or truncation of the exact value
    console.info(`ENG05-D_BYTES ${JSON.stringify({ inputUnder: bytes(under), inputOver: bytes(over), bound: RUN_INSPECTION_LIMITS.inputBytes })}`)
  })

  it('bounds the unaccepted native report without silently accepting or truncating it', () => {
    const detail = { run: { ...metadata, executionState: 'completed', outcome: 'failed' },
      execution: { ...summary, state: 'completed', finishedAt: f.createdAt },
      acceptedInput: { digest, value: emptyInput }, acceptedResult: { status: 'not_accepted' as const } }
    const reportedResult = { outcome: 'succeeded' as const, output: { text: '🙂'.repeat(16_384) } }
    expect(JSON.stringify(reportedResult).length).toBeLessThan(RUN_INSPECTION_LIMITS.resultBytes)
    expect(bytes(reportedResult)).toBeGreaterThan(RUN_INSPECTION_LIMITS.resultBytes)
    expect(RunExecutionDetailSchema.safeParse({ ...detail, reportedResult }).success).toBe(false)
    const bounded = { outcome: 'succeeded' as const, output: { text: 'small unaccepted report' } }
    expect(RunExecutionDetailSchema.parse({ ...detail, reportedResult: bounded }).acceptedResult).toEqual({ status: 'not_accepted' })
    expect(reportedResult.output.text).toHaveLength(32_768)
  })

  it('rejects overfull response arrays and preserves ordinary attempt identity without occurrence rows', () => {
    const executions = Array.from({ length: 101 }, (_, index) => ({ ...summary, executionId: `execution-${index}`, attempt: index + 1 }))
    const page = { run: metadata, items: executions.slice(0, 100), pageInfo: { nextCursor: null } }
    expect(RunExecutionsPageSchema.parse(page).items).toHaveLength(100)
    expect(RunExecutionsPageSchema.safeParse({ ...page, items: executions }).success).toBe(false)
    expect(page.items.every((execution) => !Object.hasOwn(execution, 'occurrence'))).toBe(true)
    const source = { relationshipId: 'source-edge', execution: f.identities[0], occurrence: null,
      acceptedResultDigest: digest, acceptedResult: { outcome: 'succeeded', output: { text: 'source' } } }
    const bindings = Array.from({ length: 26 }, (_, ordinal) => RunExecutionBindingSchema.parse({
      bindingId: `binding-${ordinal}`, recipient: f.identities[0], recipientOccurrence: null,
      inputDigest: digest, ordinal, kind: 'predecessor', source: { ...source, relationshipId: `source-edge-${ordinal}`,
        execution: { ...f.identities[0], executionId: `source-execution-${ordinal}` } },
    }))
    const bindingPage = { scope: f.scope, executionId: summary.executionId, inputDigest: digest, items: bindings.slice(0, 25), pageInfo: { nextCursor: null } }
    expect(RunExecutionBindingsPageSchema.parse(bindingPage).items).toHaveLength(25)
    expect(RunExecutionBindingsPageSchema.safeParse({ ...bindingPage, items: bindings }).success).toBe(false)
  })

  it.each([1, 25, 100])('reads at most limit+1 metadata rows at page size %i, including tied timestamps', (limit) => {
    const position = { createdAt: '2026-09-25T12:34:56.123456Z', executionId: 'execution-tie-breaker' }
    const scope = [f.scope, null, null]
    const cursor = encodeExecutionPageCursor(scope, position)
    // Page size may change, but scope, filter and exact keyset position may not.
    expect(decodeExecutionPageCursor(scope, cursor)).toEqual(position)
    for (const after of [undefined, position]) {
      const input = RunExecutionsListInputSchema.parse({ workspaceId: f.scope.workspaceId, runId: f.scope.runId, limit })
      const query = inspectionExecutionsQuery(input, after)
      expect(query.values).toEqual([f.scope.runId, ...(after ? [position.createdAt, position.executionId] : []), limit + 1])
      expect(query.text).toContain('order by e.created_at desc,e.id desc limit $')
      expect(query.text.includes('(e.created_at,e.id)<(')).toBe(!!after)
      expect(query.text).not.toMatch(/\boffset\b|\bcount\s*\(|input_json|result_json|harness_native_events/i)
    }
  })
})
