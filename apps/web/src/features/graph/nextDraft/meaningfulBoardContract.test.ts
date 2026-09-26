import { describe, expect, it } from 'vitest'
import { fixture } from './core.cases'
import { draftOperations, hasLocalChanges } from './model'
import { editNextDraft, newNextDraft, nextDraftDirty } from './state'
import { changeDraftAgent, hasAgentEdits } from './agentEdits'

describe('frozen board edit classification', () => {
  const movedFixture = () => {
    const context = fixture()
    const moved = { ...context.draft.graph, nodes: context.draft.graph.nodes.map((node, index) => index === 0
      ? { ...node, position: { x: 730, y: -180 } } : node) }
    return { context, moved }
  }

  it('keeps node layout out of executable dirtiness', () => {
    const { context, moved } = movedFixture()
    const edit = editNextDraft(newNextDraft(context, 'layout-only'), () => moved)

    expect(hasLocalChanges(context, moved)).toBe(false)
    expect(nextDraftDirty(edit)).toBe(false)
    expect(context.draft.revision).toBe(7)
  })

  it('does not serialize layout as a workflow operation', () => {
    const { context, moved } = movedFixture()
    expect(draftOperations(context, moved)).toEqual([])
  })

  it('stages graph and Agent meaning without mutating the accepted context', () => {
    const context = fixture()
    const original = structuredClone(context)
    const graphEdit = editNextDraft(newNextDraft(context, 'semantic'), (graph) => ({ ...graph,
      nodes: graph.nodes.map((node, index) => index === 0 ? { ...node, initialPrompt: 'Review evidence' } : node),
    }))
    const agentEdit = changeDraftAgent(graphEdit, { ...context.agents[0]!.agent, name: 'Reviewer' }, graphEdit.graph)

    expect(context).toEqual(original)
    expect(agentEdit.context.draft.revision).toBe(7)
    expect(nextDraftDirty(agentEdit)).toBe(true)
    expect(hasAgentEdits(agentEdit)).toBe(true)
    expect(draftOperations(context, agentEdit.graph, agentEdit.agentEdits)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'node.replace_v3' }),
      expect.objectContaining({ type: 'agent.rename', agentId: 'agent-0', name: 'Reviewer' }),
    ]))
  })
})
