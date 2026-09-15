import { afterEach, describe, expect, it } from 'vitest'
import type { Agent, WorkflowDefinition } from '@graphql/contracts'

import { defaultAgentForHarness } from '../agents/agentSettings'
import { getGraphDraft, useGraphDraftStore, workflowDraftKey } from './store'

const agent = { ...defaultAgentForHarness('codex', 'agent-one', 'Agent'), configurationVersionId: 'v1' }
const workflow: WorkflowDefinition = {
  id: 'workflow-one', workspaceId: 'workspace-one', name: 'Workflow',
  executionCondition: { kind: 'manual' },
  nodes: [{ id: 'node-one', agentId: agent.id, name: agent.name }], edges: [], version: 1,
}
const key = workflowDraftKey(workflow.workspaceId, workflow.id)
const store = () => useGraphDraftStore.getState()

afterEach(() => store().clearAllDrafts())

describe('PR #3 unified graph drafts', () => {
  it('keeps a settings-only draft even when the workflow definition is unchanged', () => {
    const edited = { ...agent, model: 'gpt-5.6-terra' }
    store().updateDraft(key, workflow, (current) => current, [edited])
    expect(getGraphDraft(key)?.agentOverrides[agent.id]).toEqual(edited)
    store().updateDraft(key, workflow, () => workflow)
    expect(getGraphDraft(key)?.dirty).toBe(true)
    expect(getGraphDraft(key)?.agentOverrides[agent.id]).toEqual(edited)
  })

  it('preserves newer agent edits while rebasing them onto the acknowledged version', () => {
    store().updateDraft(key, workflow, (current) => current, [agent])
    const submitted = getGraphDraft(key)!
    const newer = { ...agent, model: 'gpt-5.6-terra' }
    store().updateDraft(key, workflow, (current) => current, [newer])
    const savedWorkflow = { ...workflow, version: 2 }
    store().completeSave(key, submitted, savedWorkflow, [{ ...agent, configurationVersionId: 'v2' }])
    expect(getGraphDraft(key)?.workflow).toEqual(savedWorkflow)
    expect(getGraphDraft(key)?.agentOverrides[agent.id]).toMatchObject({
      model: 'gpt-5.6-terra', configurationVersionId: 'v2',
    })
    expect(submitted.agentOverrides[agent.id]?.model).toBe('gpt-5.6-luna')
    const second = getGraphDraft(key)!
    store().completeSave(key, second, savedWorkflow, [{ ...second.agentOverrides[agent.id]!, configurationVersionId: 'v3' }])
    expect(getGraphDraft(key)).toBeUndefined()
  })

  it('acknowledges submitted settings without discarding a node added during the request', () => {
    store().updateDraft(key, workflow, (current) => current, [agent])
    const submitted = getGraphDraft(key)!
    const added = defaultAgentForHarness('opencode', 'agent-new', 'New agent')
    store().updateDraft(key, workflow, (current) => ({
      ...current, nodes: [...current.nodes, { id: 'node-new', agentId: added.id, name: added.name }],
    }), [added])
    store().completeSave(key, submitted, { ...workflow, version: 2 }, [{ ...agent, configurationVersionId: 'v2' }])
    expect(getGraphDraft(key)?.workflow.nodes).toHaveLength(2)
    expect(getGraphDraft(key)?.agentOverrides).toEqual({ [added.id]: added })
  })

  it('does not clear settings missing from the save response', () => {
    store().updateDraft(key, workflow, (current) => current, [agent])
    const submitted = getGraphDraft(key)!
    store().completeSave(key, submitted, workflow, [])
    expect(getGraphDraft(key)?.agentOverrides[agent.id]).toEqual(agent)
  })

  it('does not rebase an edit already based on another configuration version', () => {
    store().updateDraft(key, workflow, (current) => current, [agent])
    const submitted = getGraphDraft(key)!
    const newer: Agent = { ...agent, configurationVersionId: 'external-version', model: 'gpt-5.6-terra' }
    store().updateDraft(key, workflow, (current) => current, [newer])
    store().completeSave(key, submitted, workflow, [{ ...agent, configurationVersionId: 'v2' }])
    expect(getGraphDraft(key)?.agentOverrides[agent.id]).toEqual(newer)
  })

  it('scopes both halves by workspace and workflow and discards them together', () => {
    const otherWorkflow = { ...workflow, id: 'workflow-two' }
    const otherWorkspace = { ...workflow, workspaceId: 'workspace-two' }
    const otherKey = workflowDraftKey(otherWorkflow.workspaceId, otherWorkflow.id)
    const workspaceKey = workflowDraftKey(otherWorkspace.workspaceId, otherWorkspace.id)
    for (const [draftKey, definition] of [[key, workflow], [otherKey, otherWorkflow], [workspaceKey, otherWorkspace]] as const) {
      store().updateDraft(draftKey, definition, (current) => ({ ...current, name: 'Edited' }), [agent])
    }
    store().discardDraft(key)
    expect(getGraphDraft(key)).toBeUndefined()
    expect(getGraphDraft(otherKey)?.agentOverrides[agent.id]).toEqual(agent)
    expect(getGraphDraft(workspaceKey)?.agentOverrides[agent.id]).toEqual(agent)
  })

  it('drops an override when its last workflow node is removed', () => {
    const empty = { ...workflow, nodes: [] }
    store().updateDraft(key, empty, () => workflow, [agent])
    store().updateDraft(key, empty, () => empty)
    expect(getGraphDraft(key)).toBeUndefined()
  })
})
