import { describe, expect, it } from 'vitest'
import { RepeatCapabilityV1Schema, RepeatSaveInputSchema } from './repeatAuthoring.js'

describe('repeat authoring transport contract', () => {
  it('requires explicit semantics 3 and a finite repeat plan', () => {
    const parsed = RepeatSaveInputSchema.parse({
      workspaceId: 'workspace-1', workflowId: 'workflow-1', commandId: 'command-1234',
      expectedRevision: 7, expectedWorkflowVersionId: 'workflow-1-v7', executionSemanticsVersion: 3,
      repeat: { contractVersion: 1, blocks: [{
        id: 'review-fix', nodeIds: ['work', 'review'], entryNodeId: 'work', exitNodeId: 'review',
        maxOccurrences: 3, repeatOutcome: 'issues', earlyExitOutcome: 'pass',
        limitExit: { kind: 'edge', relationshipId: 'review-limit' },
      }] },
    })
    expect(parsed.repeat.blocks[0]?.maxOccurrences).toBe(3)
  })

  it('rejects an omitted cap rather than inventing a default', () => {
    expect(() => RepeatSaveInputSchema.parse({
      workspaceId: 'workspace-1', workflowId: 'workflow-1', commandId: 'command-1234',
      expectedRevision: 0, expectedWorkflowVersionId: 'workflow-1-v1', executionSemanticsVersion: 3,
      repeat: { contractVersion: 1, blocks: [{
        id: 'review-fix', nodeIds: ['review'], entryNodeId: 'review', exitNodeId: 'review',
        repeatOutcome: 'issues', earlyExitOutcome: 'pass', limitExit: { kind: 'branch_end' },
      }] },
    })).toThrow()
  })

  it('publishes explicit capability limits', () => {
    expect(RepeatCapabilityV1Schema.parse({
      contractVersion: 1, executionSemanticsVersion: 3, supported: true,
      authoring: { flatScopesOnly: true, nesting: false, arbitraryCycles: false,
        maxOccurrencesMin: 1, maxOccurrencesMax: 2147483647, explicitLimitExit: true, earlyExitOutcome: true },
    }).authoring.nesting).toBe(false)
  })
})
