import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  RUN_INSPECTION_TOOLS, RunExecutionsListInputSchema, RunExecutionBindingsListInputSchema,
  RunExecutionSummarySchema, RunAcceptedInputValueSchema, RunVersionDetailSchema,
  RunExecutionsPageSchema, RunExecutionDetailSchema, RunExecutionBindingsPageSchema,
  CurrentOperatorToolNameSchema, makeCurrentWorkflowFixture,
} from '@foreman-code/contracts/wave25'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { OperatorRequestContext } from '../src/mcp/operator/types.js'
import {
  runInspectionRequirements, runInspectionToolAvailable, unavailableRunInspectionToolCall,
} from '../src/mcp/operator/tools/runInspection.js'
import {
  decodeBindingPageCursor, decodeExecutionPageCursor, encodeBindingPageCursor, encodeExecutionPageCursor,
} from '../src/modules/runs/inspectionCursor.js'
import { inspectionExecutionsQuery } from '../src/modules/runs/inspectionPageQuery.js'
import { runInspectionMigration } from '../src/infrastructure/runInspectionMigration.js'

const scope = [{ workspaceId: 'ws', workflowId: 'wf', runId: 'run', workflowVersionId: 'version', executionSemanticsVersion: 3 }, null, null]
const position = { createdAt: '2026-09-25T12:34:56.123456Z', executionId: 'execution-a' }
function cursorEdit(cursor: string, edit: (value: Record<string, unknown>) => void) {
  const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>
  edit(value)
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}
function context(grants: ManagementPrincipal['grants']): OperatorRequestContext {
  // Pure capability/permission tests only. Transport/native qualification is in the opt-in PostgreSQL suite.
  return { principal: { id: 'reader', name: 'Reader', audience: 'operator', grants,
    expiresAt: new Date(Date.now() + 600000).toISOString(), revokedAt: null },
  services: { runs: { inspection: {} }, commands: { recordDenied: vi.fn().mockResolvedValue(undefined) } } } as unknown as OperatorRequestContext
}

describe('ENG-05 inspection contracts and cursors', () => {
  it('requires current semantics and keeps ordinary occurrence/repeat absent', () => {
    const f = makeCurrentWorkflowFixture('inspection-unit', 'single')
    const version = RunVersionDetailSchema.parse({ scope: f.scope, version: f.version })
    expect(version.version.definition).not.toHaveProperty('repeat')
    expect(RunVersionDetailSchema.safeParse({ scope: f.scope, version: { ...f.version, executionSemanticsVersion: 2 } }).success).toBe(false)
    const ordinary = RunExecutionSummarySchema.parse({ ...f.identities[0], state: 'queued', createdAt: f.createdAt, acceptedResultAvailable: false })
    expect(ordinary).not.toHaveProperty('occurrence')
    expect(RunExecutionSummarySchema.safeParse({ ...ordinary, nativeSessionId: 'private' }).success).toBe(false)
    expect(RunExecutionSummarySchema.safeParse({ ...ordinary, input: { secret: true } }).success).toBe(false)
    expect(RunExecutionSummarySchema.safeParse({ ...ordinary, occurrence: null }).success).toBe(false)
    const exact = { executionSemanticsVersion: 3, runInput: {}, occurrence: null, entry: null, predecessors: [] }
    expect(RunAcceptedInputValueSchema.parse(exact)).toEqual(exact)
    for (const executionSemanticsVersion of [1, 2, 4, undefined]) {
      expect(RunAcceptedInputValueSchema.safeParse({ ...exact, executionSemanticsVersion }).success).toBe(false)
    }
  })

  it('bounds every requested page and generates object output schemas for all four tools', () => {
    const input = { workspaceId: 'ws', runId: 'run' }
    expect(RunExecutionsListInputSchema.parse(input).limit).toBe(25)
    expect(RunExecutionBindingsListInputSchema.parse({ ...input, executionId: 'execution' }).limit).toBe(10)
    for (const limit of [0, -1, 101, 1.5, '10']) expect(RunExecutionsListInputSchema.safeParse({ ...input, limit }).success).toBe(false)
    expect(RunExecutionBindingsListInputSchema.safeParse({ ...input, executionId: 'execution', limit: 26 }).success).toBe(false)
    expect(RunExecutionsListInputSchema.safeParse({ ...input, cursor: 'x'.repeat(4097) }).success).toBe(false)
    expect(RunExecutionsListInputSchema.safeParse({ ...input, native: true }).success).toBe(false)
    for (const name of Object.values(RUN_INSPECTION_TOOLS)) expect(CurrentOperatorToolNameSchema.parse(name)).toBe(name)
    for (const schema of [RunExecutionsPageSchema, RunExecutionDetailSchema, RunExecutionBindingsPageSchema, RunVersionDetailSchema]) {
      expect(z.toJSONSchema(schema, { unrepresentable: 'any' }).type).toBe('object')
    }
  })

  it('round-trips microseconds without Date truncation and separates kind/scope/filter/version keys', () => {
    const cursor = encodeExecutionPageCursor(scope, position)
    expect(decodeExecutionPageCursor(scope, cursor)).toEqual(position)
    expect(decodeExecutionPageCursor(scope, undefined)).toBeUndefined()
    expect(encodeExecutionPageCursor(scope, { ...position, createdAt: '2026-09-25T12:34:56.123457Z' })).not.toBe(cursor)
    for (const different of [[{ ...scope[0], runId: 'other' }, null, null],
      [{ ...scope[0], workflowVersionId: 'new-version' }, null, null], [scope[0], 'node', null], [scope[0], null, 'occurrence']]) {
      expect(() => decodeExecutionPageCursor(different, cursor)).toThrow(/exact inspection scope/)
    }
    expect(() => decodeBindingPageCursor(scope, cursor)).toThrow()
    const bindingScope = [scope[0], 'execution', 'input-digest']
    const bindingCursor = encodeBindingPageCursor(bindingScope, 0)
    expect(decodeBindingPageCursor(bindingScope, undefined)).toBe(-1)
    expect(decodeBindingPageCursor(bindingScope, bindingCursor)).toBe(0)
    expect(() => decodeBindingPageCursor([scope[0], 'other-execution', 'input-digest'], bindingCursor)).toThrow()
    expect(() => decodeBindingPageCursor([scope[0], 'execution', 'changed-digest'], bindingCursor)).toThrow()
    for (const ordinal of [-1, 0.1, 16001]) expect(() => decodeBindingPageCursor(bindingScope, encodeBindingPageCursor(bindingScope, ordinal))).toThrow()
  })

  it('rejects malformed, noncanonical and impossible cursor positions without exposing private content', () => {
    const cursor = encodeExecutionPageCursor(scope, position)
    for (const invalid of ['', '@', cursor + '=', 'a'.repeat(4097),
      cursorEdit(cursor, (value) => { value.version = 2 }),
      cursorEdit(cursor, (value) => { value.extra = 'private' }),
      ...['2026-02-30T12:34:56.123456Z', '2026-09-25T24:34:56.123456Z', '2026-09-25T12:34:56.123Z'].map((createdAt) =>
        encodeExecutionPageCursor(scope, { ...position, createdAt })),
      encodeExecutionPageCursor(scope, { ...position, executionId: 'bad\0id' })]) {
      try { decodeExecutionPageCursor(scope, invalid); throw new Error('accepted invalid cursor') }
      catch (error) { expect(error).toMatchObject({ code: 'RUN_INSPECTION_CURSOR_INVALID', status: 400 }) }
    }
  })
})

describe('ENG-05 indexed bounded metadata query', () => {
  it('uses separate parameterized keyset shapes, at most limit + 1, and no private bodies', () => {
    for (const workflowNodeId of [undefined, 'node-with.dots:and-dashes']) for (const occurrenceId of [undefined, 'occurrence']) {
      for (const after of [undefined, position]) {
        const input = RunExecutionsListInputSchema.parse({ workspaceId: 'ws', runId: 'run', workflowNodeId, occurrenceId, limit: 100 })
        const query = inspectionExecutionsQuery(input, after)
        expect(query.values).toEqual(['run', ...(workflowNodeId ? [workflowNodeId] : []), ...(occurrenceId ? [occurrenceId] : []),
          ...(after ? [after.createdAt, after.executionId] : []), 101])
        expect(query.text).toContain('order by e.created_at desc,e.id desc limit $')
        expect(query.text).not.toMatch(/\boffset\b|\bcount\s*\(|\bOR\b|input_json|result_json|harness_native_events/i)
        expect(query.text).not.toContain("e.record->'input'")
        expect(query.text).not.toMatch(/\be\.record\s*[,\n]/)
        expect(query.text).not.toContain("node' OR true --")
        expect(query.text.includes('(e.created_at,e.id)<(')).toBe(!!after)
      }
    }
    expect(runInspectionMigration.sql.match(/create index /g)).toHaveLength(5)
    expect(runInspectionMigration.sql.replace(/,\s*/g, ',')).toContain('(run_id,recipient_execution_id,ordinal)')
    expect(runInspectionMigration.sql).not.toMatch(/update|delete|insert|trigger/i)
  })
})

describe('ENG-05 compatible read-only grants and hidden-call denial', () => {
  it('advertises reads, requires workflow read separately, and rejects disjoint grant scopes', () => {
    const reader = context([{ actions: ['runs:read'], scope: { workspaceIds: ['ws'], runIds: ['run'] } }])
    for (const name of [RUN_INSPECTION_TOOLS.executions, RUN_INSPECTION_TOOLS.execution, RUN_INSPECTION_TOOLS.bindings]) {
      expect(runInspectionToolAvailable(reader, name)).toBe(true)
      expect(runInspectionRequirements(name)).toEqual(['runs:read'])
    }
    expect(runInspectionToolAvailable(reader, RUN_INSPECTION_TOOLS.version)).toBe(false)
    reader.principal.grants.push({ actions: ['workflows:read'], scope: { workspaceIds: ['other'] } })
    expect(runInspectionToolAvailable(reader, RUN_INSPECTION_TOOLS.version)).toBe(false)
    reader.principal.grants.push({ actions: ['workflows:read'], scope: { workspaceIds: ['ws'], workflowIds: ['wf'] } })
    expect(runInspectionToolAvailable(reader, RUN_INSPECTION_TOOLS.version)).toBe(true)
    expect(runInspectionRequirements(RUN_INSPECTION_TOOLS.version)).toEqual(['runs:read', 'workflows:read'])
    expect(runInspectionToolAvailable(reader, RUN_INSPECTION_TOOLS.version, { workspaceId: 'ws', workflowId: 'wf', runId: 'other' })).toBe(false)
    for (const mutation of [(p: ManagementPrincipal) => { p.revokedAt = new Date().toISOString() },
      (p: ManagementPrincipal) => { p.expiresAt = '2020-01-01T00:00:00Z' }]) {
      const revoked = structuredClone(reader.principal); mutation(revoked)
      expect(runInspectionToolAvailable({ ...reader, principal: revoked }, RUN_INSPECTION_TOOLS.execution)).toBe(false)
    }
    expect(runInspectionToolAvailable(context([{ actions: ['runs:read'], scope: { runIds: [] } }]), RUN_INSPECTION_TOOLS.execution)).toBe(false)
  })

  it('does not turn a valid late grant intersection into an arbitrary denial', () => {
    const grants: ManagementPrincipal['grants'] = []
    for (let index = 0; index < 110; index++) {
      grants.push({ actions: ['runs:read'], scope: { workspaceIds: [`run-workspace-${index}`] } })
      grants.push({ actions: ['workflows:read'], scope: { workspaceIds: [`version-workspace-${index}`] } })
    }
    grants.push({ actions: ['runs:read'], scope: { workspaceIds: ['matching'] } },
      { actions: ['workflows:read'], scope: { workspaceIds: ['matching'] } })
    expect(runInspectionToolAvailable(context(grants), RUN_INSPECTION_TOOLS.version)).toBe(true)
  })

  it('audits a hidden tool as denied rather than exposing an unknown-tool result; distinguishes unavailable composition', async () => {
    const denied = context([])
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: RUN_INSPECTION_TOOLS.execution,
      arguments: { workspaceId: 'ws', runId: 'run', executionId: 'execution' } } }
    const result = await unavailableRunInspectionToolCall(denied, body)
    expect(result?.result.isError).toBe(true)
    expect(result?.result.content).toEqual([{ type: 'text', text: expect.stringContaining('ACCESS_DENIED') }])
    expect(denied.services.commands.recordDenied).toHaveBeenCalledTimes(1)
    const unavailable = { ...denied, services: { ...denied.services, runs: undefined } } as unknown as OperatorRequestContext
    const missing = await unavailableRunInspectionToolCall(unavailable, body)
    expect(missing?.result.content).toEqual([{ type: 'text', text: expect.stringContaining('RUN_INSPECTION_UNAVAILABLE') }])
  })
})
