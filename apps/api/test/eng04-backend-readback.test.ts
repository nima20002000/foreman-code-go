import { describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import {
  makeWave25Fixture, RepeatWorkflowVersionV1Schema, RepeatWorkflowRunV1Schema,
  RepeatDecisionV1Schema, RepeatOccurrenceV1Schema, REPEAT_READBACK_MAX_BYTES, canonicalGraphJson,
  type RepeatRunReadInput,
} from '@graphql/contracts/wave25'
import { RepeatReadbackService } from '../src/modules/repeats/readback.js'

function fixture() {
  const f = makeWave25Fixture('eng04-backend-read')
  const entry = f.version.definition.nodes[0]!, exit = f.version.definition.nodes[1]!
  const version = RepeatWorkflowVersionV1Schema.parse({ ...f.version, executionSemanticsVersion: 3,
    definition: { ...f.version.definition, executionSemanticsVersion: 3,
      executionPolicy: { maxParallelism: 1, maxNodeExecutions: 200 },
      nodes: [entry, { ...exit, choice: { outcomes: [
        { outcome: 'pass', target: { kind: 'branch_end' } }, { outcome: 'issues', target: { kind: 'branch_end' } },
      ] } }],
      repeat: { contractVersion: 1, blocks: [{ id: 'repair', nodeIds: [entry.id, exit.id], entryNodeId: entry.id,
        exitNodeId: exit.id, maxOccurrences: 100, repeatOutcome: 'issues', earlyExitOutcome: 'pass', limitExit: { kind: 'branch_end' } }] },
    } })
  const run = RepeatWorkflowRunV1Schema.parse({ ...f.run, executionSemanticsVersion: 3 })
  const principal: ManagementPrincipal = { id: 'eng04-backend-reader', name: 'Synthetic reader', audience: 'operator',
    expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null,
    grants: [{ actions: ['workflows:read', 'graph:read', 'runs:read'], scope: { workspaceIds: [run.workspaceId], workflowIds: [run.workflowId] } }] }
  const row = { record: run, workflow_version_id: version.id, version_record: version,
    execution_semantics_version: 3, version: version.version, entry_node_id: version.entryNodeId }
  const query = vi.fn().mockResolvedValue({ rows: [row] })
  const list = vi.fn().mockResolvedValue({ items: [], nextCursor: null })
  const service = new RepeatReadbackService({ query } as unknown as pg.Pool, { list })
  const input: RepeatRunReadInput = { workspaceId: run.workspaceId, workflowId: run.workflowId, runId: run.id,
    limit: 50, includeResultData: false }
  const digest = 'sha256:' + '0'.repeat(64)
  function item(index = 1, resultSize = 8) {
    const occurrence = RepeatOccurrenceV1Schema.parse({ contractVersion: 1,
      identity: { scope: { ...f.scope, executionSemanticsVersion: 3 }, blockId: 'repair', occurrenceId: `occ-${index}`, occurrenceIndex: index },
      input: { bindingId: `input-${index}`, inputDigest: digest, previous: index === 1 ? null : {
        occurrenceId: `occ-${index - 1}`, occurrenceIndex: index - 1, decisionId: `decision-${index - 1}`, acceptedResultDigest: digest,
      } },
    })
    const decision = RepeatDecisionV1Schema.parse({ contractVersion: 1, decisionId: `decision-${index}`, occurrence,
      exitExecution: { ...f.identities[1]!, executionId: `exit-${index}`, occurrence: occurrence.identity },
      acceptedResultDigest: digest, outcome: 'issues', reason: 'repeat',
      target: { kind: 'next_occurrence', entryNodeId: entry.id, occurrenceIndex: index + 1 }, decidedAt: f.createdAt,
      resultData: { latestDeliverable: 'private-' + 'x'.repeat(resultSize), remainingFindings: ['private-finding'] },
    })
    return { occurrence, decision }
  }
  return { f, version, run, row, query, list, service, input, principal, item }
}

describe('ENG04 backend exact immutable readback', () => {
  it('passes the exact Run version to storage and removes private data even if storage supplies it', async () => {
    const t = fixture(), item = t.item()
    t.list.mockResolvedValue({ items: [item], nextCursor: null })
    const page = await t.service.run(t.principal, t.input)
    expect(t.list).toHaveBeenCalledWith(expect.objectContaining({ workflowVersionId: t.version.id, runId: t.run.id }))
    expect(page.items[0]!.decision).not.toHaveProperty('resultData')
    expect(JSON.stringify(page)).not.toContain('private-')
    const detail = await t.service.run(t.principal, { ...t.input, includeResultData: true })
    expect(detail.items[0]!.decision).toEqual(item.decision)
    expect(item.decision.resultData.latestDeliverable).toContain('private-')
  })

  it.each(['configurations', 'approval', 'scope', 'record-id', 'version-column', 'entry-column'])('rejects %s drift before consulting occurrence storage', async (kind) => {
    const t = fixture()
    if (kind === 'configurations') t.row.record = { ...t.run, agentConfigurationVersionIds: {} }
    if (kind === 'approval') t.row.record = { ...t.run, approval: { handler: 'orchestrator', designatedOrchestratorAgentId: 'wrong' } } as never
    if (kind === 'scope') t.row.record = { ...t.run, workflowId: 'other-workflow' }
    if (kind === 'record-id') t.row.record = { ...t.run, id: 'other-run' }
    if (kind === 'version-column') t.row.version++
    if (kind === 'entry-column') t.row.entry_node_id = 'other-entry'
    await expect(t.service.run(t.principal, t.input)).rejects.toMatchObject({ code: 'REPEAT_RUN_PIN_INVALID' })
    expect(t.list).not.toHaveBeenCalled()
  })

  it('rejects a decision substituting an occurrence input binding despite matching occurrence identity', async () => {
    const t = fixture(), item = t.item()
    item.decision.occurrence = { ...item.occurrence, input: { ...item.occurrence.input, bindingId: 'substituted' } }
    t.list.mockResolvedValue({ items: [item], nextCursor: null })
    await expect(t.service.run(t.principal, t.input)).rejects.toBeTruthy()
  })

  it.each(['duplicate', 'cursor', 'scope'])('rejects an invalid %s page', async (kind) => {
    const t = fixture(), item = t.item()
    const items = kind === 'duplicate' ? [item, item] : [item]
    if (kind === 'scope') item.occurrence.identity.scope.runId = 'other-run'
    t.list.mockResolvedValue({ items, nextCursor: kind === 'cursor' ? 'unreturned-cursor' : null })
    await expect(t.service.run(t.principal, t.input)).rejects.toBeTruthy()
  })

  it('trims only a large tail and continues after the last returned occurrence without truncating results', async () => {
    const t = fixture(), items = Array.from({ length: 16 }, (_, i) => t.item(i + 1, 60000))
    t.list.mockResolvedValue({ items, nextCursor: null })
    const page = await t.service.run(t.principal, { ...t.input, includeResultData: true })
    expect(page.items.length).toBeGreaterThan(0)
    expect(page.items.length).toBeLessThan(items.length)
    expect(new TextEncoder().encode(canonicalGraphJson(page, REPEAT_READBACK_MAX_BYTES)).length).toBeLessThanOrEqual(REPEAT_READBACK_MAX_BYTES)
    expect(page.pageInfo.nextCursor).toBe(page.items.at(-1)!.occurrence.identity.occurrenceId)
    expect(page.items).toEqual(items.slice(0, page.items.length))
  })

  it('denies a scoped read before querying the Run and rejects malformed service input', async () => {
    const t = fixture()
    await expect(t.service.run({ ...t.principal, grants: [] }, t.input)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    await expect(t.service.run(t.principal, { ...t.input, limit: 101 })).rejects.toBeTruthy()
    expect(t.query).not.toHaveBeenCalled()
  })
})
