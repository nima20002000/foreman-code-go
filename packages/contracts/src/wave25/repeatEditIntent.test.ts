import { describe, expect, it } from 'vitest'
import { makeWave25Fixture } from './fixtures.js'
import { GraphEditStageInputSchema } from './editIntent.js'
import { RepeatWorkflowVersionV1Schema } from './repeat.js'
import {
  RepeatEditIntentSchema, RepeatEditReadResultSchema, RepeatEditStageInputSchema,
  RepeatGetToolInputSchema, RepeatGetToolResultSchema,
  RepeatMutationInputSchema, RepeatMutationToolInputSchema, RepeatMutationToolResultSchema,
  RepeatSaveInputSchema, type RepeatEditIntent,
} from './repeatAuthoring.js'

const ids = Array.from({ length: 6 }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`)
const digest = `sha256:${'a'.repeat(64)}`
function fixture() {
  const f = makeWave25Fixture('repeat-edit-contract')
  const [entry, exit] = f.version.definition.nodes
  if (!entry || !exit) throw new Error('Two-node fixture required')
  const repeat = { contractVersion: 1 as const, blocks: [{ id: 'repair', nodeIds: [entry.id, exit.id],
    entryNodeId: entry.id, exitNodeId: exit.id, maxOccurrences: 2, repeatOutcome: 'issues', earlyExitOutcome: 'pass',
    limitExit: { kind: 'branch_end' as const } }] }
  const scope = { workspaceId: f.version.workspaceId, workflowId: f.version.workflowId }
  const saveInput = RepeatSaveInputSchema.parse({ ...scope, commandId: ids[1], expectedRevision: 7,
    expectedWorkflowVersionId: f.version.id, executionSemanticsVersion: 3, repeat })
  const stage = RepeatEditStageInputSchema.parse({ ...saveInput, commandId: ids[0], action: 'stage_edits',
    draftId: 'repeat-editor-instance', expectedAgentConfigurationVersionIds: f.version.agentConfigurationVersionIds,
    expectedLocationRevision: 4 })
  const intent = RepeatEditIntentSchema.parse({ ...scope, kind: 'repeat', id: 'graph-edit-repeat', ownerPrincipalId: 'writer',
    draftId: stage.draftId, stageCommandId: stage.commandId, stageInputHash: digest,
    advanceCommandId: ids[2], advanceInputHash: digest, discardCommandId: ids[3], discardInputHash: digest,
    expectedRevision: 7, savedWorkflowRevision: 7, expectedWorkflowVersionId: f.version.id,
    stagedDraft: { ...scope, id: stage.draftId, revision: 7, baseWorkflowVersionId: f.version.id,
      repeat, agentConfigurationVersionIds: f.version.agentConfigurationVersionIds,
      locationRevision: 4, locationDigest: digest, runLocationPins: [] },
    agentPins: Object.entries(f.version.agentConfigurationVersionIds).map(([agentId, configurationVersionId]) => ({
      agentId, configurationVersionId, metadataRevision: 1,
    })), affected: [], stops: [], saveInput, saveInputHash: digest,
    state: 'staged', saveAttempted: false, createdAt: f.version.createdAt, updatedAt: f.version.createdAt })
  const version = RepeatWorkflowVersionV1Schema.parse({ ...f.version, id: `${f.version.id}-repeat`, version: f.version.version + 1,
    executionSemanticsVersion: 3, definition: { ...f.version.definition, version: f.version.version + 1,
      executionSemanticsVersion: 3, repeat, executionPolicy: { maxParallelism: 1, maxNodeExecutions: 6 },
      nodes: [entry, { ...exit, choice: { outcomes: [
        { outcome: 'pass', target: { kind: 'branch_end' } }, { outcome: 'issues', target: { kind: 'branch_end' } },
      ] } }],
    } })
  const saved = { ...scope, revision: 8, currentVersionId: version.id, version }
  const command = (action: 'stop_and_save' | 'discard_edits') => ({ ...scope, action, draftId: intent.draftId,
    intentId: intent.id, commandId: action === 'stop_and_save' ? intent.advanceCommandId : intent.discardCommandId })
  return { f, scope, stage, intent, saveInput, saved, command }
}

describe('repeat private edit contracts share durable actions without weakening v2', () => {
  it('keeps the legacy v2 Stage shape and rejects reinterpretation as v3', () => {
    const { stage } = fixture()
    const legacy = { workspaceId: stage.workspaceId, workflowId: stage.workflowId, draftId: stage.draftId,
      commandId: ids[0], expectedRevision: 0, expectedWorkflowVersionId: stage.expectedWorkflowVersionId,
      executionSemanticsVersion: 2, action: 'stage_edits', operations: [] }
    expect(GraphEditStageInputSchema.safeParse(legacy).success).toBe(true)
    expect(GraphEditStageInputSchema.safeParse(stage).success).toBe(false)
    expect(RepeatEditStageInputSchema.safeParse(legacy).success).toBe(false)
  })
  it('requires displayed immutable Agent and location pins and a stable editor identity', () => {
    const { stage } = fixture()
    for (const key of ['draftId', 'expectedWorkflowVersionId', 'expectedAgentConfigurationVersionIds', 'expectedLocationRevision'] as const) {
      const input: Record<string, unknown> = { ...stage }; delete input[key]
      expect(RepeatEditStageInputSchema.safeParse(input).success, key).toBe(false)
    }
  })
  it.each([0, -1, 1.5, Infinity, 2147483648])('rejects unsupported finite cap %s', (cap) => {
    const { stage } = fixture()
    stage.repeat.blocks[0]!.maxOccurrences = cap
    expect(RepeatEditStageInputSchema.safeParse(stage).success).toBe(false)
  })
  it.each([1, 2, 4, 99])('rejects non-v3 repeat Stage semantics %s', (version) => {
    expect(RepeatEditStageInputSchema.safeParse({ ...fixture().stage, executionSemanticsVersion: version }).success).toBe(false)
  })
  it('rejects missing explicit limit exit and hidden nesting/authority/Stop identity fields', () => {
    const { stage } = fixture()
    const block = stage.repeat.blocks[0]!
    const { limitExit, ...missingLimit } = block; void limitExit
    for (const input of [
      { ...stage, stopCommandId: ids[4] }, { ...stage, principalId: 'other' }, { ...stage, restart: true },
      { ...stage, repeat: { ...stage.repeat, blocks: [missingLimit] } },
      { ...stage, repeat: { ...stage.repeat, blocks: [{ ...block, nested: [] }] } },
    ]) expect(RepeatEditStageInputSchema.safeParse(input).success).toBe(false)
  })
  it('accepts the direct-save backwards-compatible tool variant and the three strict actions', () => {
    const f = fixture()
    for (const input of [f.saveInput, f.stage, f.command('stop_and_save'), f.command('discard_edits')]) {
      expect(RepeatMutationInputSchema.safeParse(input).success).toBe(true)
      expect(RepeatMutationToolInputSchema.safeParse(input).success).toBe(true)
    }
  })
  it('the object-root MCP facade cannot mix action fields or accept incomplete commands', () => {
    const f = fixture()
    for (const input of [
      { ...f.saveInput, draftId: 'extra' }, { ...f.command('stop_and_save'), repeat: f.stage.repeat },
      { ...f.command('discard_edits'), expectedRevision: 7 }, { ...f.stage, intentId: 'caller-chosen' },
      { ...f.scope, commandId: ids[0], action: 'stop_and_save' },
      { ...f.stage, action: 'unknown' },
    ]) expect(RepeatMutationToolInputSchema.safeParse(input).success).toBe(false)
  })
  it('keeps saved and caller-private MCP read shapes distinct', () => {
    const f = fixture()
    expect(RepeatGetToolInputSchema.safeParse(f.scope).success).toBe(true)
    expect(RepeatGetToolInputSchema.safeParse({ ...f.scope, action: 'read_edits', draftId: f.stage.draftId }).success).toBe(true)
    expect(RepeatGetToolInputSchema.safeParse({ ...f.scope, draftId: f.stage.draftId }).success).toBe(false)
    expect(RepeatGetToolInputSchema.safeParse({ ...f.scope, action: 'read_edits' }).success).toBe(false)
    expect(RepeatGetToolInputSchema.safeParse({ ...f.scope, action: 'read_edits', draftId: f.stage.draftId, commandId: ids[0] }).success).toBe(false)
  })
  it('accepts a complete journal, not substitutions of scope/baseline/Agent/location/command pins', () => {
    const original = fixture().intent
    const bad: Array<(value: RepeatEditIntent) => void> = [
      (v) => { v.stagedDraft.id = 'replacement-editor' },
      (v) => { v.stagedDraft.workflowId = 'other' },
      (v) => { v.stagedDraft.baseWorkflowVersionId = 'other' },
      (v) => { v.savedWorkflowRevision++ },
      (v) => { v.saveInput.repeat.blocks[0]!.maxOccurrences++ },
      (v) => { v.agentPins.pop() },
      (v) => { v.agentPins[0]!.metadataRevision = null },
      (v) => { v.agentPins[0]!.configurationVersionId = null },
      (v) => { v.agentPins.push(v.agentPins[0]!) },
      (v) => { v.stagedDraft.runLocationPins.push({ runId: 'unplanned', digest }) },
      (v) => { v.discardCommandId = v.advanceCommandId },
      (v) => { v.saveInput.commandId = v.stageCommandId },
      (v) => { v.state = 'saved' },
    ]
    expect(RepeatEditIntentSchema.safeParse(original).success).toBe(true)
    for (const mutate of bad) {
      const input = structuredClone(original); mutate(input)
      expect(RepeatEditIntentSchema.safeParse(input).success).toBe(false)
    }
  })
  it('pins every affected Run and only the exact planned Stop subset', () => {
    const f = fixture(), intent = structuredClone(f.intent)
    intent.affected = [{ ...f.scope, runId: 'run-exact', workflowVersionId: f.stage.expectedWorkflowVersionId,
      executionSemanticsVersion: 2, agentConfigurationVersionIds: f.stage.expectedAgentConfigurationVersionIds }]
    intent.stagedDraft.runLocationPins = [{ runId: 'run-exact', digest }]
    intent.stops = [{ input: { workspaceId: f.scope.workspaceId, runId: 'run-exact', commandId: ids[4]! }, inputHash: digest }]
    expect(RepeatEditIntentSchema.safeParse(intent).success).toBe(true)
    intent.stops[0]!.receipt = { runId: 'other', status: 'accepted', processStopped: false }
    expect(RepeatEditIntentSchema.safeParse(intent).success).toBe(false)
    delete intent.stops[0]!.receipt
    intent.affected[0]!.workflowId = 'other'
    expect(RepeatEditIntentSchema.safeParse(intent).success).toBe(false)
  })
  it('acknowledges only the exact immutable v3 result and revision increment', () => {
    const f = fixture()
    const saved = { ...f.intent, state: 'saved', saveAttempted: true, result: f.saved }
    expect(RepeatEditIntentSchema.safeParse(saved).success).toBe(true)
    expect(RepeatEditIntentSchema.safeParse({ ...saved, state: 'waiting' }).success).toBe(false)
    expect(RepeatEditIntentSchema.safeParse({ ...saved, result: { ...f.saved, revision: 9 } }).success).toBe(false)
    const wrong = structuredClone(f.saved); wrong.version.definition.repeat.blocks[0]!.maxOccurrences = 1
    expect(RepeatEditIntentSchema.safeParse({ ...saved, result: wrong }).success).toBe(false)
  })
  it('uses strict complete output variants even when the MCP root is an object', () => {
    const f = fixture(), read = { intent: f.intent, current: [], canStop: true, affectedSetChanged: false }
    const direct = { value: f.saved, replayed: false }
    expect(RepeatEditReadResultSchema.safeParse(read).success).toBe(true)
    for (const output of [read, direct]) expect(RepeatMutationToolResultSchema.safeParse(output).success).toBe(true)
    expect(RepeatMutationToolResultSchema.safeParse({ ...read, ...direct }).success).toBe(false)
    expect(RepeatMutationToolResultSchema.safeParse({ intent: null }).success).toBe(false)
    expect(RepeatGetToolResultSchema.safeParse(read).success).toBe(true)
    expect(RepeatGetToolResultSchema.safeParse({ ...f.saved, contractVersion: 1, executionSemanticsVersion: 3 }).success).toBe(true)
    expect(RepeatGetToolResultSchema.safeParse({}).success).toBe(false)
  })
})
