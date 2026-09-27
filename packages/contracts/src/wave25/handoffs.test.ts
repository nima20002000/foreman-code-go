import { describe, expect, it } from 'vitest'
import { makeCurrentWorkflowFixture } from './currentFixture.js'
import { WorkflowDefinitionV3Schema, WorkflowVersionV3Schema } from './saved.js'
import {
  WorkHandoffResultSchema, WorkHandoffUsageSchema, WorkNoticeSchema, WorkReturnSchema,
  canAdmitWorkHandoff, consumesWorkHandoffSlot, workConnectionForRequest,
} from './handoffs.js'

const fixture = makeCurrentWorkflowFixture('handoffs-contract')
const [a, b] = fixture.version.definition.nodes
const original = fixture.version.definition.edges[0]!
const c = { id: 'node-c', agentId: 'agent-c', name: 'C' }
const d = { id: 'node-d', agentId: 'agent-d', name: 'D' }
const edge = (id: string, source: string, target: string, cap?: number) => ({
  id, source, target, kind: 'execution' as const,
  ...(cap === undefined ? {} : { maxWorkHandoffsPerRun: cap }),
})
const graph = (edges: unknown[], extra: Record<string, unknown> = {}) => ({
  ...fixture.version.definition, nodes: [a, b, c, d], edges, handoffs: { contractVersion: 1 },
  executionPolicy: { maxParallelism: 2, maxNodeExecutions: 20 }, ...extra,
})

describe('FLOW-01 versioned work handoff contract', () => {
  it('preserves exact old ordinary and finite-repeat definitions', () => {
    for (const form of ['sequential', 'repeat'] as const) {
      const old = makeCurrentWorkflowFixture(`old-${form}`, form).version
      expect(WorkflowVersionV3Schema.parse(old)).toEqual(old)
      expect(Object.hasOwn(old.definition, 'handoffs')).toBe(false)
    }
  })

  it('pins a new policy and independent limits on connections that share B', () => {
    const definition = WorkflowDefinitionV3Schema.parse(graph([
      edge('ab', a!.id, b!.id, 2), edge('bc', b!.id, c.id, 3), edge('bd', b!.id, d.id),
    ]))
    expect(definition.handoffs).toEqual({ contractVersion: 1 })
    expect(workConnectionForRequest(definition, b!.id, c.id)?.id).toBe('bc')
    expect(workConnectionForRequest(definition, b!.id, d.id)?.maxWorkHandoffsPerRun).toBeUndefined()
    expect(workConnectionForRequest(definition, c.id, b!.id)).toBeUndefined()
    expect(workConnectionForRequest(definition, a!.id, d.id)).toBeUndefined()
    const scope = fixture.scope
    const bc = { scope, relationshipId: 'bc', used: 0, maxWorkHandoffsPerRun: 3 }
    const ab = { ...bc, relationshipId: 'ab', maxWorkHandoffsPerRun: 2 }
    expect([0, 1, 2, 3].map((used) => canAdmitWorkHandoff(WorkHandoffUsageSchema.parse({ ...bc, used })))).toEqual([true, true, true, false])
    expect(canAdmitWorkHandoff(WorkHandoffUsageSchema.parse({ ...ab, used: 2 }))).toBe(false)
    expect(canAdmitWorkHandoff(WorkHandoffUsageSchema.parse({ ...bc, used: 2 }))).toBe(true)
    expect(canAdmitWorkHandoff(WorkHandoffUsageSchema.parse({ ...bc, used: 10000, maxWorkHandoffsPerRun: null }))).toBe(true)
  })

  it('round trips the new marker and line limit through an immutable saved version', () => {
    const version = WorkflowVersionV3Schema.parse({ ...fixture.version, definition: {
      ...fixture.version.definition, handoffs: { contractVersion: 1 },
      edges: [{ ...original, maxWorkHandoffsPerRun: 3 }],
    } })
    expect(version.definition.handoffs).toEqual({ contractVersion: 1 })
    expect(WorkflowVersionV3Schema.parse(version)).toEqual(version)
    expect(version.definition.edges[0]?.maxWorkHandoffsPerRun).toBe(3)
  })

  it('rejects invalid caps, unmarked limits, approval limits, duplicate directions and block mixing', () => {
    for (const cap of [0, -1, 1.5, '3', null, 2147483648]) {
      expect(WorkflowDefinitionV3Schema.safeParse(graph([edge('bc', b!.id, c.id, cap as number)])).success).toBe(false)
    }
    expect(WorkflowDefinitionV3Schema.safeParse({ ...fixture.version.definition,
      edges: [{ ...original, maxWorkHandoffsPerRun: 3 }] }).success).toBe(false)
    expect(WorkflowDefinitionV3Schema.safeParse(graph([
      { ...edge('bc', b!.id, c.id), kind: 'approval', maxWorkHandoffsPerRun: 3 },
    ])).success).toBe(false)
    expect(WorkflowDefinitionV3Schema.safeParse(graph([
      edge('bc', b!.id, c.id, 3), edge('cb', c.id, b!.id, 3),
    ])).success).toBe(false)
    const oldRepeat = makeCurrentWorkflowFixture('old-repeat-mixed', 'repeat').version.definition
    expect(WorkflowDefinitionV3Schema.safeParse({ ...oldRepeat, handoffs: { contractVersion: 1 } }).success).toBe(false)
  })

  it('allows explicit reverse new work but never creates a second pair allowance', () => {
    const definition = WorkflowDefinitionV3Schema.parse(graph([
      { ...edge('bc', b!.id, c.id, 3), workRequestDirection: 'both' },
    ]))
    expect(workConnectionForRequest(definition, c.id, b!.id)?.id).toBe('bc')
  })

  it('charges only a new business work request and requires truthful return and notice shapes', () => {
    expect(['work_request', 'work_return', 'permission_exchange', 'approval_exchange',
      'technical_retry', 'replay', 'progress', 'system_notice', 'delivery_acknowledgement']
      .map((kind) => consumesWorkHandoffSlot(kind as Parameters<typeof consumesWorkHandoffSlot>[0])))
      .toEqual([true, false, false, false, false, false, false, false, false])
    const result = { routing: { kind: 'return', requestId: 'request-3', outcome: 'needs_changes' },
      data: { latestDeliverable: { id: 'artifact-3' }, remainingFindings: [{ id: 'finding-1' }] } }
    expect(WorkHandoffResultSchema.parse(result)).toEqual(result)
    expect(WorkHandoffResultSchema.safeParse({ ...result, routing: { kind: 'return', outcome: 'needs_changes' } }).success).toBe(false)
    expect(WorkHandoffResultSchema.safeParse({ ...result, data: { ...result.data, latestDeliverable: 'x'.repeat(65536) } }).success).toBe(false)
    const returned = { scope: fixture.scope, returnId: 'return-3', requestId: 'request-3',
      sourceActivationId: 'activation-c-3', requesterActivationId: 'activation-b-3',
      acceptedResultDigest: `sha256:${'0'.repeat(64)}`, outcome: 'needs_changes',
      latestDeliverable: result.data.latestDeliverable, remainingFindings: result.data.remainingFindings,
      returnedAt: fixture.createdAt }
    expect(WorkReturnSchema.parse(returned)).toEqual(returned)
    expect(WorkReturnSchema.safeParse({ ...returned, latestDeliverable: null }).success).toBe(false)
    const notice = { scope: fixture.scope, noticeId: 'notice-3', requesterActivationId: 'activation-b-3',
      cause: { kind: 'last_return', returnId: 'return-3' }, continuationActivationId: 'activation-b-4', delivery: 'pending' }
    expect(WorkNoticeSchema.parse(notice)).toEqual(notice)
    expect(WorkNoticeSchema.safeParse({ ...notice, delivery: 'delivered' }).success).toBe(false)
    expect(WorkNoticeSchema.safeParse({ ...notice, delivery: 'delivered', acknowledgementId: 'ack-3' }).success).toBe(true)
  })
})
