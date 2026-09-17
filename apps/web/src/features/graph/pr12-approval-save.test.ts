import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, type WorkflowDefinition } from '@graphql/contracts'
import type { GraphDraft } from '@graphql/contracts/management'
import { captureManagedBase, sameEditableGraph } from './managedGraphState'
import { managementGraphOperations } from './managementDiff'
import { getGraphDraft, useGraphDraftStore, workflowDraftKey } from './store'
import { defaultAgentForHarness, initialModel, nextCoderAgentName } from '../agents/agentSettings'

const workflow: WorkflowDefinition = { id: 'w', workspaceId: 's', name: 'Workflow', executionCondition: { kind: 'manual' }, approval: { handler: 'user' }, nodes: [], edges: [] }
const shared: GraphDraft = { id: 'd', workspaceId: 's', workflowId: 'w', revision: 0, baseWorkflowVersionId: 'v1', publishedRevision: 0, graph: workflow, stagedAgents: [], updatedByPrincipalId: 'p', updatedAt: '2026-09-16T00:00:00.000Z' }
beforeEach(() => useGraphDraftStore.getState().clearAllDrafts())
describe('PR12 approval dirty/save protocol', () => {
  it.each(['user', 'operator', 'orchestrator'] as const)('transmits %s approval as a graph operation', (handler) => {
    const base = { ...workflow, approval: undefined }
    const next = { ...workflow, approval: handler === 'orchestrator' ? { handler, designatedOrchestratorAgentId: 'o1' } : { handler } }
    expect(sameEditableGraph(base, next)).toBe(false)
    expect(managementGraphOperations({ base, next, baseAgents: [], nextAgents: [], metadataRevisions: {} })).toContainEqual({ type: 'workflow.set_approval', approval: next.approval })
  })
  it('tracks changing only the designated Orchestrator', () => {
    const base = { ...workflow, approval: { handler: 'orchestrator' as const, designatedOrchestratorAgentId: 'o1' } }
    const next = { ...base, approval: { ...base.approval, designatedOrchestratorAgentId: 'o2' } }
    expect(managementGraphOperations({ base, next, baseAgents: [], nextAgents: [], metadataRevisions: {} })).toEqual([{ type: 'workflow.set_approval', approval: next.approval }])
  })
  it('keeps approval-only dirty state and newer edits after a save acknowledgment', () => {
    const key = workflowDraftKey('s', 'w'); const store = useGraphDraftStore.getState()
    const base = captureManagedBase(shared, [], {})
    store.updateDraft(key, workflow, (value) => ({ ...value, approval: { handler: 'operator' } }), [], base)
    const sent = structuredClone(getGraphDraft(key)!)
    store.setManagedSaving(key, true)
    expect(sent.workflow.approval?.handler).toBe('operator')
    store.updateDraft(key, workflow, (value) => ({ ...value, approval: { handler: 'user' } }), [], base)
    expect(getGraphDraft(key)?.workflow.approval?.handler).toBe('user')
    const saved = { ...sent.workflow, version: 2 }
    const acknowledged = captureManagedBase({ ...shared, revision: 2, graph: saved }, [], {})
    store.completeSave(key, sent, saved, [], acknowledged)
    expect(getGraphDraft(key)?.workflow.approval?.handler).toBe('user')
    store.setManagedSaving(key, false)
    expect(getGraphDraft(key)?.managedBase?.draft.revision).toBe(2)
  })
  it('does not replace a saved custom model and counts the final Coder namespace', () => {
    const agent = defaultAgentForHarness('opencode', 'a', 'coder-001', { ...DEFAULT_HARNESS_DEFAULTS.opencode, model: 'custom/model', variant: 'custom-variant' })
    expect(initialModel(agent, 'opencode')).toBe('custom/model')
    expect(agent.effort).toBeUndefined()
    expect(nextCoderAgentName([agent, { id: 'b', name: 'coder-002', harness: 'codex' }])).toBe('coder-003')
  })
})
