import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import type { GraphEditRunState } from '@graphql/contracts/wave25'
import { readAffectedGraphRuns } from '../src/modules/graph-drafts/saveAdmission.js'
import { sameAffectedSet } from '../src/modules/graph-drafts/editIntent.js'
import { CANCELED_INTERACTION_RETIRED_SQL } from '../src/modules/interactions/wave25/publication.js'

const pin = { workspaceId: 'workspace', workflowId: 'workflow', workflowVersionId: 'version', runId: 'run',
  executionSemanticsVersion: 2 as const, agentConfigurationVersionIds: { agent: 'configuration' } }
const settled: GraphEditRunState = { pin, terminal: true, settled: true, outcome: 'succeeded',
  nativePending: false, cleanupPending: false, interactionPending: false, reviewPending: false }
const row = { id: pin.runId, workspace_id: pin.workspaceId, workflow_id: pin.workflowId, workflow_version_id: pin.workflowVersionId,
  record: { ...pin, executionSemanticsVersion: 2, outcome: 'succeeded', agentConfigurationVersionIds: pin.agentConfigurationVersionIds },
  terminal: true, cleanup: false, native: false, interactions: false, reviews: false }
const scope = { workspaceId: pin.workspaceId, workflowId: pin.workflowId, stagedAgentIds: ['shared'] }

describe('NIM-2642 exact affected-set and current settlement mapping', () => {
  it('keeps outcome changes independent of immutable accepted identities', () => {
    expect(sameAffectedSet({ affected: [pin] }, [settled])).toBe(true)
    expect(sameAffectedSet({ affected: [pin] }, [{ ...settled, outcome: 'failed' }])).toBe(true)
    expect(sameAffectedSet({ affected: [pin] }, [{ ...settled, settled: false }])).toBe(true)
  })
  it.each(['runId', 'workflowId', 'workflowVersionId', 'workspaceId'] as const)('rejects changed %s even after terminal settlement', (field) => {
    expect(sameAffectedSet({ affected: [pin] }, [{ ...settled, pin: { ...pin, [field]: 'other' } }])).toBe(false)
  })
  it('rejects added/missing Runs and changed Agent or semantics pins', () => {
    expect(sameAffectedSet({ affected: [pin] }, [])).toBe(false)
    expect(sameAffectedSet({ affected: [pin] }, [settled, { ...settled, pin: { ...pin, runId: 'new' } }])).toBe(false)
    expect(sameAffectedSet({ affected: [pin] }, [{ ...settled, pin: { ...pin, executionSemanticsVersion: 1 } }])).toBe(false)
    expect(sameAffectedSet({ affected: [pin] }, [{ ...settled, pin: { ...pin, agentConfigurationVersionIds: { agent: 'new' } } }])).toBe(false)
  })
  it('requires the canceled retirement source receipt and counts unlaunched reviews by owning interaction', async () => {
    const query = vi.fn(async () => ({ rows: [row], rowCount: 1 }))
    const result = await readAffectedGraphRuns({ query } as unknown as Pick<pg.PoolClient, 'query'>, scope)
    expect(result).toEqual([settled])
    const [sql] = query.mock.calls[0]! as unknown as [string, unknown[]]
    expect(sql).toContain(CANCELED_INTERACTION_RETIRED_SQL)
    expect(sql).toContain('review_owner.id=j.interaction_id')
    expect(sql).toContain('review_owner.run_id=r.id')
    expect(sql).toContain("e.record->'result'->>'outcome'")
    expect(sql).toContain('workflow_finalized_at is not null')
    expect(sql).toContain('b.revoked_at is null')
    expect(sql).toContain("v.record->'agentConfigurationVersionIds'=r.record->'agentConfigurationVersionIds'")
    expect(sql).not.toMatch(/\b(insert|update|delete)\b/i)
    expect(sql).not.toMatch(/order by r\.id\s+limit/i)
  })
  it.each(['cleanup', 'native', 'interactions', 'reviews'] as const)('waits beyond terminal on %s, including absent evidence', async (field) => {
    for (const value of [true, null, undefined]) {
      const query = vi.fn(async () => ({ rows: [{ ...row, [field]: value }], rowCount: 1 }))
      const [state] = await readAffectedGraphRuns({ query } as unknown as Pick<pg.PoolClient, 'query'>, scope)
      expect(state?.terminal).toBe(true); expect(state?.settled).toBe(false)
    }
  })
  it('does not promote unknown terminal evidence to settled', async () => {
    const query = vi.fn(async () => ({ rows: [{ ...row, terminal: undefined }], rowCount: 1 }))
    expect((await readAffectedGraphRuns({ query } as unknown as Pick<pg.PoolClient, 'query'>, scope))[0]?.settled).toBe(false)
  })
})
