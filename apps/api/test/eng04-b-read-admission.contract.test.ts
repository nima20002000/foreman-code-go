import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { ManagementPrincipalSchema, RunStartInputSchema } from '@graphql/contracts/management'
import {
  CanonicalRunGraphReadCapabilitiesSchema, CanonicalRunGraphScopeSchema, RunGraphScopeSchema,
  ManualRunStartInputSchema, RunStartV2InputSchema, RunStartV3InputSchema,
} from '@graphql/contracts/wave25'
import { RunGraphReadService } from '../src/modules/run-graph/readService.js'
import { canonicalRunGraphReadApi } from '../src/modules/run-graph/repeatReadService.js'

const scope = { workspaceId: 'workspace-test', workflowId: 'workflow-test', workflowVersionId: 'version-test', runId: 'run-test', executionSemanticsVersion: 3 as const }
const principal = ManagementPrincipalSchema.parse({ id: 'principal-test', name: 'Read-only contract test', audience: 'operator',
  expiresAt: '2999-01-01T00:00:00.000Z', revokedAt: null, grants: [{ actions: ['runs:read'], scope: {} }] })
const legacyStart = { workspaceId: scope.workspaceId, workflowId: scope.workflowId, workflowVersionId: scope.workflowVersionId,
  commandId: randomUUID(), input: {}, expectedLocationRevision: 1 }
const start = { ...legacyStart, executionSemanticsVersion: 3, expectedWorkflowRevision: 2,
  expectedAgentConfigurationVersionIds: { 'agent-test': 'configuration-test' } }

describe('ENG04-B strict read discovery and manual admission contracts', () => {
  it('adds a distinct v3 Start arm without widening the legacy or v2 validators', () => {
    expect(ManualRunStartInputSchema.parse(legacyStart)).toEqual(RunStartInputSchema.parse(legacyStart))
    expect(ManualRunStartInputSchema.parse({ ...legacyStart, executionSemanticsVersion: 2 }))
      .toEqual(RunStartV2InputSchema.parse({ ...legacyStart, executionSemanticsVersion: 2 }))
    expect(ManualRunStartInputSchema.parse(start)).toEqual(RunStartV3InputSchema.parse(start))
    expect(RunStartInputSchema.safeParse(start).success).toBe(false)
    expect(RunStartV2InputSchema.safeParse(start).success).toBe(false)
  })

  it.each(['workflowVersionId', 'expectedWorkflowRevision', 'expectedAgentConfigurationVersionIds', 'expectedLocationRevision', 'commandId'])(
    'requires the explicit v3 %s pin', (key) => {
      const input: Record<string, unknown> = { ...start }
      delete input[key]
      expect(ManualRunStartInputSchema.safeParse(input).success).toBe(false)
    })

  it.each([0, 4, '3', null, '03'])('does not coerce unknown semantics %s into a supported Start', (executionSemanticsVersion) => {
    expect(ManualRunStartInputSchema.safeParse({ ...start, executionSemanticsVersion }).success).toBe(false)
  })

  it('rejects extra admission flags and half a displayed-draft pin', () => {
    for (const extra of [{ qualified: true }, { runtimeAdmission: true }, { draftId: 'draft-test' }, { expectedDraftRevision: 1 }]) {
      expect(ManualRunStartInputSchema.safeParse({ ...start, ...extra }).success).toBe(false)
    }
    expect(ManualRunStartInputSchema.safeParse({ ...start, draftId: 'draft-test', expectedDraftRevision: 1 }).success).toBe(true)
  })

  it('keeps the legacy graph scope strictly 1/2 while canonical dispatch has an explicit 3 arm', () => {
    expect(RunGraphScopeSchema.safeParse(scope).success).toBe(false)
    expect(CanonicalRunGraphScopeSchema.parse(scope)).toEqual(scope)
    for (const executionSemanticsVersion of [1, 2]) {
      expect(RunGraphScopeSchema.safeParse({ ...scope, executionSemanticsVersion }).success).toBe(true)
    }
    for (const executionSemanticsVersion of [4, '3', undefined]) {
      expect(CanonicalRunGraphScopeSchema.safeParse({ ...scope, executionSemanticsVersion }).success).toBe(false)
    }
  })

  it('separates read support from runtime/edit permission and rejects contradictory discovery', () => {
    const capabilities = { capabilityVersion: 1, protocolVersions: [1], readSemanticsVersions: [2, 3],
      transport: 'http_poll', activePollMs: 1000,
      semantics3: { persistedReads: true, payload: 'metadata_only', runtimeAdmission: false, meaningfulEdit: false } }
    expect(CanonicalRunGraphReadCapabilitiesSchema.parse(capabilities)).toEqual(capabilities)
    const invalid = [
      { ...capabilities, readSemanticsVersions: [2] }, { ...capabilities, readSemanticsVersions: [2, 3, 3] },
      { ...capabilities, protocolVersions: [] },
      { ...capabilities, semantics3: { ...capabilities.semantics3, runtimeAdmission: true } },
      { ...capabilities, semantics3: { ...capabilities.semantics3, meaningfulEdit: true } },
    ]
    for (const value of invalid) expect(CanonicalRunGraphReadCapabilitiesSchema.safeParse(value).success).toBe(false)
  })

  it('constructs the repeat reader explicitly and leaves its default closed without consulting SQL', async () => {
    const connect = vi.fn(() => { throw new Error('Closed read must not acquire SQL') })
    const pool = { connect } as unknown as pg.Pool
    const assemble = async () => { throw new Error('V3 must not call the legacy assembler') }
    const legacy = new RunGraphReadService(pool, assemble, { qualifiedReads: true })
    const reads = canonicalRunGraphReadApi(legacy)
    expect(legacy.repeat.qualifiedReads).toBe(false)
    expect(reads.readCapabilities(principal).readSemanticsVersions).toEqual([2])
    await expect(reads.snapshot(principal, { protocolVersion: 1, scope })).rejects.toMatchObject({ code: 'GRAPH_NOT_INITIALIZED' })
    expect(connect).not.toHaveBeenCalled()
    const qualified = new RunGraphReadService(pool, assemble, { qualifiedReads: true, qualifiedRepeatReads: true })
    expect(canonicalRunGraphReadApi(qualified).readCapabilities(principal).readSemanticsVersions).toEqual([2, 3])
    expect(qualified.capabilities(principal)).toEqual(legacy.capabilities(principal))
    expect(connect).not.toHaveBeenCalled()
    expect(() => reads.readCapabilities({ ...principal, revokedAt: '2026-01-01T00:00:00.000Z' }))
      .toThrow(expect.objectContaining({ code: 'GRAPH_READ_ACCESS_DENIED' }))
  })
})
