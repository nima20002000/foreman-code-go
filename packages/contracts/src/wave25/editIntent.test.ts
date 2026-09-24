import { describe, expect, it } from 'vitest'
import { GraphEditAdvanceInputSchema, GraphEditDiscardInputSchema, GraphEditReadInputSchema,
  GraphEditRunPinSchema, GraphEditRunStateSchema, GraphEditStageInputSchema, GraphEditStopSchema } from './editIntent.js'

const scope = { workspaceId: 'workspace', workflowId: 'workflow', draftId: 'draft' }
const stage = { ...scope, action: 'stage_edits', commandId: 'same-stage', expectedRevision: 7,
  expectedWorkflowVersionId: 'version', executionSemanticsVersion: 2, operations: [] }
const pin = { workspaceId: 'workspace', workflowId: 'workflow', workflowVersionId: 'version', runId: 'run',
  executionSemanticsVersion: 2, agentConfigurationVersionIds: { agent: 'configuration' } }

describe('NIM-2642 private edit protocol boundary', () => {
  it('admits typed stage/read/advance/discard with distinct exact actions', () => {
    expect(GraphEditStageInputSchema.parse(stage)).toEqual(stage)
    expect(GraphEditReadInputSchema.parse({ ...scope, action: 'read_edits' })).toEqual({ ...scope, action: 'read_edits' })
    const command = { ...scope, intentId: 'intent', commandId: 'command' }
    expect(GraphEditAdvanceInputSchema.parse({ ...command, action: 'stop_and_save' }).commandId).toBe('command')
    expect(GraphEditDiscardInputSchema.parse({ ...command, action: 'discard_edits' }).commandId).toBe('command')
    expect(GraphEditAdvanceInputSchema.safeParse({ ...command, action: 'discard_edits' }).success).toBe(false)
  })
  it.each(['selectedRunId', 'stops', 'ownerPrincipalId', 'saveInput', 'credentials', 'editIntentId'])(
    'never admits caller-invented authority or journal field %s', (field) => {
      expect(GraphEditStageInputSchema.safeParse({ ...stage, [field]: 'untrusted' }).success).toBe(false)
    })
  it('requires exact draft revision, saved version and explicit v2 identity', () => {
    for (const field of ['expectedRevision', 'expectedWorkflowVersionId', 'executionSemanticsVersion']) {
      const value: Record<string, unknown> = { ...stage }; delete value[field]
      expect(GraphEditStageInputSchema.safeParse(value).success).toBe(false)
    }
    expect(GraphEditStageInputSchema.safeParse({ ...stage, expectedRevision: -1 }).success).toBe(false)
    expect(GraphEditStageInputSchema.safeParse({ ...stage, operations: Array.from({ length: 101 }, () => ({ type: 'workflow.set_entry', entryNodeId: null })) }).success).toBe(false)
  })
  it('does not reinterpret a Stop receipt as process-exit or settlement evidence', () => {
    const value = { input: { workspaceId: 'workspace', runId: 'run', commandId: 'stop' }, inputHash: 'sha256:' + '1'.repeat(64),
      receipt: { runId: 'run', status: 'accepted', processStopped: false } }
    expect(GraphEditStopSchema.parse(value)).toEqual(value)
    expect(GraphEditStopSchema.safeParse({ ...value, receipt: { ...value.receipt, processStopped: true } }).success).toBe(false)
    expect(GraphEditStopSchema.safeParse({ ...value, inputHash: 'sha256:wrong' }).success).toBe(false)
  })
  it('retains exact Run/version/Agent pins and explicit post-terminal pending fields', () => {
    expect(GraphEditRunPinSchema.parse(pin)).toEqual(pin)
    const current = { pin, terminal: true, settled: false, outcome: 'succeeded', cleanupPending: true,
      nativePending: true, interactionPending: true, reviewPending: true }
    expect(GraphEditRunStateSchema.parse(current)).toEqual(current)
    const missing = { ...current, nativePending: undefined }
    expect(GraphEditRunStateSchema.safeParse(missing).success).toBe(false)
  })
})
