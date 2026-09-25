import { describe, expect, it } from 'vitest'
import { makeSharedLegacyFixture, makeSharedV3Fixture } from './eng04-shared-fixture.js'
import {
  SavedWorkflowDefinitionSchema, SavedWorkflowVersionSchema, SavedWorkflowRunSchema, SavedRunDetailsSchema,
  SavedRunVersionSnapshotSchema, SavedManagedWorkflowSchema, SavedWorkspaceDetailsSchema,
} from './saved.js'
import {
  RunStartV3InputSchema, RepeatStartSnapshotV1Schema, AcceptedRepeatStartV1Schema,
  AcceptedWorkflowRunV3Schema, ExecutableWorkflowV3Schema,
} from './repeatAdmission.js'
import { CompatibleWorkflowVersionSchema, CompatibleWorkflowRunSchema } from './workflow.js'
import { RunStartV2InputSchema } from './authoring.js'
import { GraphEditRunPinSchema } from './editIntent.js'

describe('ENG04 shared saved/read compatibility', () => {
  it('preserves exact v1/v2/v3 data and does not turn read support into old-engine admission', () => {
    const f = makeSharedV3Fixture(), v1 = makeSharedLegacyFixture()
    for (const item of [v1, f.legacyFixture, f]) {
      expect(SavedWorkflowDefinitionSchema.parse(item.version.definition)).toEqual(item.version.definition)
      expect(SavedWorkflowVersionSchema.parse(item.version)).toEqual(item.version)
      expect(SavedWorkflowRunSchema.parse(item.run)).toEqual(item.run)
      expect(SavedRunVersionSnapshotSchema.parse({ run: item.run, version: item.version }).version).toEqual(item.version)
      expect(SavedRunDetailsSchema.safeParse({ run: item.run, executions: [], activity: [] }).success).toBe(true)
    }
    expect(SavedWorkspaceDetailsSchema.shape.workflows.safeParse([f.version.definition]).success).toBe(true)
    expect(SavedWorkspaceDetailsSchema.shape.workflows.safeParse([{ ...f.version.definition, executionSemanticsVersion: 4 }]).success).toBe(false)
    expect(CompatibleWorkflowVersionSchema.safeParse(f.version).success).toBe(false)
    expect(CompatibleWorkflowRunSchema.safeParse(f.run).success).toBe(false)
    expect(RunStartV2InputSchema.safeParse(f.request).success).toBe(false)
    expect(SavedManagedWorkflowSchema.safeParse({ workflow: f.version.definition, revision: 7,
      currentVersionId: f.version.id, archivedAt: null }).success).toBe(true)
  })
  it.each([0, 1, 4, '3', null])('rejects unknown or conflicting version tag %s without stripping repeat metadata', (tag) => {
    const f = makeSharedV3Fixture()
    expect(SavedWorkflowVersionSchema.safeParse({ ...f.version, executionSemanticsVersion: tag }).success).toBe(false)
    expect(SavedWorkflowDefinitionSchema.safeParse({ ...f.version.definition, executionSemanticsVersion: tag }).success).toBe(false)
    expect(SavedWorkflowRunSchema.safeParse({ ...f.run, executionSemanticsVersion: tag }).success).toBe(false)
  })
  it('checks Run/version scope, semantics, configurations, approval and execution condition', () => {
    const f = makeSharedV3Fixture()
    for (const run of [
      { ...f.run, workspaceId: 'other' }, { ...f.run, workflowId: 'other' }, { ...f.run, workflowVersionId: 'other' },
      { ...f.run, executionSemanticsVersion: 2 }, { ...f.run, agentConfigurationVersionIds: {} },
      { ...f.run, approval: undefined }, { ...f.run, executionCondition: { kind: 'manual', description: 'changed' } },
    ]) expect(SavedRunVersionSnapshotSchema.safeParse({ run, version: f.version }).success).toBe(false)
  })
  it('checks execution and activity scope while preserving public location/principal redaction', () => {
    const f = makeSharedV3Fixture(), execution = f.executions[0]!
    const { executionLocation, authorizationPrincipalId, ...visible } = f.run
    void executionLocation; void authorizationPrincipalId
    expect(SavedWorkflowRunSchema.safeParse(visible).success).toBe(true)
    expect(AcceptedWorkflowRunV3Schema.safeParse(visible).success).toBe(false)
    for (const executions of [[{ ...execution, runId: 'other' }], [{ ...execution, agentConfigurationVersionId: 'other' }], [execution, execution]]) {
      expect(SavedRunDetailsSchema.safeParse({ run: f.run, executions, activity: [] }).success).toBe(false)
    }
    expect(SavedRunDetailsSchema.safeParse({ run: f.run, executions: [], activity: [{
      id: 'event-1', runId: 'other', sequence: 1, source: 'backend', kind: 'run_state_changed', occurredAt: f.createdAt, payload: {},
    }] }).success).toBe(false)
    expect(GraphEditRunPinSchema.safeParse({ workspaceId: f.run.workspaceId, workflowId: f.run.workflowId,
      runId: f.run.id, workflowVersionId: f.version.id, executionSemanticsVersion: 3,
      agentConfigurationVersionIds: f.run.agentConfigurationVersionIds }).success).toBe(true)
  })
})

describe('ENG04 shared v3 Start constraints (not a runtime admission test)', () => {
  it('retains v3 and exact accepted pins on a new queued Run', () => {
    const f = makeSharedV3Fixture()
    expect(ExecutableWorkflowV3Schema.parse({ version: f.version, configurations: f.configurations }).version).toEqual(f.version)
    expect(AcceptedRepeatStartV1Schema.parse({ snapshot: f.snapshot, run: f.run }).run).toEqual(f.run)
  })
  it('requires workflow/configuration revision identity and the complete optional draft pair', () => {
    const f = makeSharedV3Fixture()
    for (const request of [
      { ...f.request, expectedWorkflowRevision: undefined }, { ...f.request, expectedAgentConfigurationVersionIds: undefined },
      { ...f.request, draftId: 'draft-only' }, { ...f.request, expectedDraftRevision: 1 },
      { ...f.request, executionSemanticsVersion: 4 }, { ...f.request, permissionBypass: true },
    ]) expect(RunStartV3InputSchema.safeParse(request).success).toBe(false)
  })
  it('rejects stale or forged workflow/location/current-version/configuration pins', () => {
    const f = makeSharedV3Fixture()
    for (const snapshot of [
      { ...f.snapshot, request: { ...f.request, expectedWorkflowRevision: 6 } },
      { ...f.snapshot, request: { ...f.request, expectedLocationRevision: 5 } },
      { ...f.snapshot, request: { ...f.request, expectedAgentConfigurationVersionIds: {} } },
      { ...f.snapshot, workflow: { ...f.snapshot.workflow, currentVersionId: 'other' } },
      { ...f.snapshot, workflow: { ...f.snapshot.workflow, archived: true } },
      { ...f.snapshot, workspace: { ...f.snapshot.workspace, archived: true } },
      { ...f.snapshot, workspace: { ...f.snapshot.workspace, location: { ...f.location, rootPath: 'relative' } } },
      { ...f.snapshot, workspace: { ...f.snapshot.workspace, location: { ...f.location, identityHash: 'sha256:invalid' } } },
    ]) expect(RepeatStartSnapshotV1Schema.safeParse(snapshot).success).toBe(false)
  })
  it('requires every immutable configuration, exact workspace/Agent/role/native approval compatibility', () => {
    const f = makeSharedV3Fixture()
    for (const configurations of [[], [f.configurations[0]!], [...f.configurations, f.configurations[0]!],
      f.configurations.map((c) => ({ ...c, workspaceId: 'other' })),
      f.configurations.map((c) => ({ ...c, id: `${c.id}-replacement` })),
      f.configurations.map((c) => ({ ...c, productRole: undefined })),
      f.configurations.map((c) => ({ ...c, harness: { ...c.harness, harness: 'unknown-provider' } })),
    ]) expect(ExecutableWorkflowV3Schema.safeParse({ version: f.version, configurations }).success).toBe(false)
  })
  it('allows current display geometry/name but not changed executable repeat meaning', () => {
    const f = makeSharedV3Fixture()
    const definition = { ...f.version.definition, name: 'renamed', nodes: f.version.definition.nodes.map((node) => ({ ...node, position: { x: 12, y: 34 } })) }
    expect(RepeatStartSnapshotV1Schema.safeParse({ ...f.snapshot, workflow: { ...f.snapshot.workflow, definition } }).success).toBe(true)
    definition.nodes[0]!.initialPrompt = 'unpublished executable change'
    expect(RepeatStartSnapshotV1Schema.safeParse({ ...f.snapshot, workflow: { ...f.snapshot.workflow, definition } }).success).toBe(false)
  })
  it('requires the exact published displayed draft with no staged Agent edits', () => {
    const f = makeSharedV3Fixture()
    const draft = { id: 'draft-1', workspaceId: f.run.workspaceId, workflowId: f.run.workflowId,
      revision: 9, publishedRevision: 9, baseWorkflowVersionId: f.version.id, graph: f.version.definition,
      stagedAgents: [], updatedByPrincipalId: 'synthetic-principal', updatedAt: f.createdAt }
    const snapshot = { ...f.snapshot, request: { ...f.request, draftId: draft.id, expectedDraftRevision: 9 }, draft }
    expect(RepeatStartSnapshotV1Schema.safeParse(snapshot).success).toBe(true)
    for (const replacement of [null, { ...draft, id: 'other' }, { ...draft, workspaceId: 'other' },
      { ...draft, revision: 8 }, { ...draft, publishedRevision: null }, { ...draft, baseWorkflowVersionId: 'old-version' }]) {
      expect(RepeatStartSnapshotV1Schema.safeParse({ ...snapshot, draft: replacement }).success).toBe(false)
    }
  })
  it('does not let a new Run change input/location or manufacture a terminal result', () => {
    const f = makeSharedV3Fixture()
    for (const run of [{ ...f.run, input: { changed: true } }, { ...f.run, authorizationPrincipalId: 'another-principal' },
      { ...f.run, executionLocation: { ...f.location, rootPath: '/other' } },
      { ...f.run, executionState: 'completed', outcome: 'succeeded', result: { outcome: 'succeeded' }, finishedAt: f.createdAt },
    ]) expect(AcceptedRepeatStartV1Schema.safeParse({ snapshot: f.snapshot, run }).success).toBe(false)
  })
})
