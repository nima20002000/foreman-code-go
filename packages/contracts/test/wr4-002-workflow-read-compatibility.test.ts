import { describe, expect, it } from 'vitest'
import {
  CompatibleWorkflowDefinitionSchema, GetWorkflowResponseSchema, SaveWorkflowRequestSchema,
  WorkflowDefinitionSchema, WorkflowDefinitionV2Schema, WorkspaceDetailsResponseSchema,
} from '../src/index.js'
import { ManagedWorkflowSchema, ManagedWorkflowPageSchema } from '../src/management/index.js'
import {
  CompatibleWorkflowDefinitionSchema as Wave25ReadSchema, WorkflowDefinitionV2Schema as Wave25V2Schema,
  WAVE25_ADMISSION_ENABLED, assertWave25Admission, makeWave25Fixture,
} from '../src/wave25/index.js'

const fixture = makeWave25Fixture('wr4-002-contracts')
const legacy = WorkflowDefinitionSchema.parse({
  id: 'legacy', workspaceId: fixture.scope.workspaceId, name: 'Legacy sibling',
  executionCondition: { kind: 'manual' },
  nodes: [{ id: 'legacy-node', agentId: 'legacy-agent', name: 'Legacy Worker' }], edges: [],
})
const typed = WorkflowDefinitionV2Schema.parse({
  ...fixture.version.definition,
  nodes: fixture.version.definition.nodes.map((node, index) => index === 0 ? { ...node, choice: { outcomes: [
    { outcome: 'pass', target: { kind: 'branch_end' } },
    { outcome: 'issues', target: { kind: 'edge', relationshipId: fixture.version.definition.edges[0]!.id } },
  ] } } : node),
  // Editable/read shape only, not an executable-acceptance fixture. The migrated
  // API test separately saves a role/configuration-valid approval relationship.
  edges: [...fixture.version.definition.edges, { id: 'approval', kind: 'approval',
    source: fixture.version.entryNodeId, target: fixture.version.definition.nodes[1]!.id }],
})
const managed = (workflow: unknown) => ({ workflow, revision: 2, currentVersionId: null, archivedAt: null })

describe('WR4-002 strict versioned persisted read contracts', () => {
  it('shares the same root/wave25 schemas without a new import cycle under the activation candidate', () => {
    expect(Wave25ReadSchema).toBe(CompatibleWorkflowDefinitionSchema)
    expect(Wave25V2Schema).toBe(WorkflowDefinitionV2Schema)
    expect(WAVE25_ADMISSION_ENABLED).toBe(true)
    expect(() => assertWave25Admission()).not.toThrow()
  })
  it('roundtrips legacy and exact tagged, typed records without mutating either input', () => {
    for (const definition of [legacy, typed]) {
      const before = structuredClone(definition)
      expect(CompatibleWorkflowDefinitionSchema.parse(definition)).toStrictEqual(before)
      expect(definition).toStrictEqual(before)
      expect(GetWorkflowResponseSchema.parse({ workflow: definition }).workflow).toStrictEqual(before)
      expect(ManagedWorkflowSchema.parse(managed(definition)).workflow).toStrictEqual(before)
    }
  })
  it('keeps a legacy sibling readable in the same workspace aggregate and managed page', () => {
    const details = WorkspaceDetailsResponseSchema.parse({
      workspace: { id: fixture.scope.workspaceId, name: 'Mixed workspace' },
      workflows: [legacy, typed], agents: [], runs: [], resources: [], runners: [],
    })
    expect(details.workflows).toStrictEqual([legacy, typed])
    const page = ManagedWorkflowPageSchema.parse({ items: [managed(legacy), managed(typed)], pageInfo: { nextCursor: null } })
    expect(page.items.map((item) => item.workflow)).toStrictEqual([legacy, typed])
    expect(WorkflowDefinitionSchema.parse(details.workflows[0])).toStrictEqual(legacy)
  })
  it('does not loosen legacy decoding or the legacy product save request', () => {
    expect(WorkflowDefinitionSchema.safeParse(typed).success).toBe(false)
    expect(WorkflowDefinitionSchema.safeParse({ ...legacy, executionSemanticsVersion: 1 }).success).toBe(false)
    expect(WorkflowDefinitionSchema.safeParse({ ...legacy, extra: 'unknown' }).success).toBe(false)
    expect(WorkflowDefinitionSchema.safeParse({ ...legacy, edges: typed.edges }).success).toBe(false)
    expect(SaveWorkflowRequestSchema.safeParse({ workspaceId: typed.workspaceId, workflow: typed }).success).toBe(false)
  })
  it.each([
    { ...typed, executionSemanticsVersion: 3 },
    { ...typed, executionSemanticsVersion: undefined },
    { ...typed, entryNodeId: undefined },
    { ...typed, edges: typed.edges.map((edge) => ({ ...edge, kind: undefined })) },
    { ...typed, edges: typed.edges.map((edge) => ({ ...edge, kind: 'unknown' })) },
    { ...typed, edges: typed.edges.map((edge) => ({ ...edge, route: { outcomes: ['succeeded'] } })) },
    { ...typed, extra: 'unknown' },
  ])('fails closed for unsupported or incompletely tagged definitions %#', (invalid) => {
    expect(CompatibleWorkflowDefinitionSchema.safeParse(invalid).success).toBe(false)
    expect(GetWorkflowResponseSchema.safeParse({ workflow: invalid }).success).toBe(false)
    expect(ManagedWorkflowSchema.safeParse(managed(invalid)).success).toBe(false)
  })
})
