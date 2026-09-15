import { beforeEach, describe, expect, it } from 'vitest'
import { AgentSchema, WorkflowDefinitionSchema } from '@graphql/contracts'
import { GraphDraftApplyInputSchema, GraphDraftSchema } from '@graphql/contracts/management'
import { captureManagedBase, assertManagedBase, managedDraftIsPublished } from './managedGraphState'
import { managementGraphOperations } from './managementDiff'
import { useGraphDraftStore, workflowDraftKey } from './store'

const makeAgent = (id = 'agent-a') => AgentSchema.parse({
  id, name: id, harness: 'codex', model: 'test-model', effort: 'high',
  configurationVersionId: `${id}-v1`, prompt: { system: 'Keep this prompt' },
  assignedSkills: [{ skillId: 'skill-a', version: 'v1' }],
  harnessConfiguration: { harness: 'codex', model: 'test-model', reasoningEffort: 'high', sandbox: 'read-only', serviceTier: 'standard' },
})
const makeWorkflow = () => WorkflowDefinitionSchema.parse({
  id: 'workflow-a', workspaceId: 'workspace-a', name: 'Workflow', executionCondition: { kind: 'manual' },
  nodes: [{ id: 'node-a', agentId: 'agent-a', name: 'Agent' }], edges: [],
})
const makeDraft = () => GraphDraftSchema.parse({
  id: 'draft-a', workspaceId: 'workspace-a', workflowId: 'workflow-a', graph: makeWorkflow(),
  revision: 3, publishedRevision: 3, baseWorkflowVersionId: 'workflow-v1', stagedAgents: [],
  updatedByPrincipalId: 'principal-a', updatedAt: '2026-09-15T00:00:00.000Z',
})
const key = workflowDraftKey('workspace-a', 'workflow-a')
beforeEach(() => useGraphDraftStore.getState().clearAllDrafts())

describe('managed graph audit regressions', () => {
  it('F04 requires an exact publication marker, including legacy records', () => {
    const draft = makeDraft()
    expect(managedDraftIsPublished(draft)).toBe(true)
    expect(managedDraftIsPublished({ ...draft, revision: 4 })).toBe(false)
    expect(managedDraftIsPublished({ ...draft, publishedRevision: undefined })).toBe(false)
  })
  it('F05 retains the original base across another edit after navigation', () => {
    const base = captureManagedBase(makeDraft(), [makeAgent()], { 'agent-a': 1 })
    useGraphDraftStore.getState().updateDraft(key, makeWorkflow(), (workflow) => ({
      ...workflow, nodes: workflow.nodes.map((node) => ({ ...node, width: 300 })),
    }), [], base)
    const remote = { ...makeDraft(), revision: 4 }
    useGraphDraftStore.getState().updateDraft(key, makeWorkflow(), (workflow) => ({
      ...workflow, nodes: workflow.nodes.map((node) => ({ ...node, height: 180 })),
    }), [], captureManagedBase(remote, [makeAgent()], { 'agent-a': 1 }))
    const pinned = useGraphDraftStore.getState().drafts[key]!.managedBase!
    expect(pinned.draft.revision).toBe(3)
    expect(() => assertManagedBase(pinned, remote)).toThrow('changed elsewhere')
  })
  it('F05 F09 preserves edits made while publication is in flight', () => {
    const base = captureManagedBase(makeDraft(), [makeAgent()], { 'agent-a': 1 })
    useGraphDraftStore.getState().updateDraft(key, makeWorkflow(), (workflow) => ({
      ...workflow, nodes: workflow.nodes.map((node) => ({ ...node, width: 300 })),
    }), [], base)
    const submitted = structuredClone(useGraphDraftStore.getState().drafts[key]!)
    useGraphDraftStore.getState().updateDraft(key, makeWorkflow(), (workflow) => ({
      ...workflow, nodes: workflow.nodes.map((node) => ({ ...node, width: 400 })),
    }), [], base)
    const saved = { ...makeDraft(), revision: 5, publishedRevision: 5, graph: submitted.workflow }
    useGraphDraftStore.getState().completeSave(key, submitted, submitted.workflow, [makeAgent()],
      captureManagedBase(saved, [makeAgent()], { 'agent-a': 1 }))
    expect(useGraphDraftStore.getState().drafts[key]!.workflow.nodes[0]!.width).toBe(400)
    expect(useGraphDraftStore.getState().drafts[key]!.managedBase!.draft.revision).toBe(5)
  })
  it('F10 emits an authorized clone with prompt and skill overrides', () => {
    const agent = makeAgent()
    const copy = { ...agent, id: 'copy', name: 'Copy', configurationVersionId: undefined }
    const base = makeWorkflow()
    const next = { ...base, nodes: [...base.nodes, { id: 'copy-node', agentId: copy.id, name: copy.name }] }
    const operations = managementGraphOperations({ base, next, baseAgents: [agent], nextAgents: [agent, copy],
      metadataRevisions: { [agent.id]: 1 }, cloneSources: { [copy.id]: agent.id } })
    expect(operations[0]?.type).toBe('agent.clone')
    expect(operations.find((operation) => operation.type === 'agent.configure')).toMatchObject({
      prompt: agent.prompt, assignedSkills: agent.assignedSkills,
    })
    expect(GraphDraftApplyInputSchema.safeParse({ workspaceId: base.workspaceId, workflowId: base.id,
      draftId: 'draft-a', commandId: 'copy-command', expectedRevision: 3, operations }).success).toBe(true)
  })
  it('F11 sends node sizing rather than clearing an unsent resize', () => {
    const base = makeWorkflow(), agent = makeAgent()
    const next = { ...base, nodes: base.nodes.map((node) => ({ ...node, width: 350, height: 220 })) }
    expect(managementGraphOperations({ base, next, baseAgents: [agent], nextAgents: [agent], metadataRevisions: {} }))
      .toEqual([{ type: 'node.replace', node: next.nodes[0] }])
  })
  it('F12 accepts null base revision for an MCP-staged new agent', () => {
    const base = makeWorkflow(), agent = makeAgent()
    expect(managementGraphOperations({ base, next: base, baseAgents: [agent], nextAgents: [{ ...agent, name: 'Renamed' }],
      metadataRevisions: { [agent.id]: null } })).toEqual([
      { type: 'agent.rename', agentId: agent.id, name: 'Renamed', expectedAgentRevision: 0 },
    ])
  })
})
