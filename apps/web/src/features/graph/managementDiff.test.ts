import { describe, expect, it } from 'vitest'

import { DEFAULT_HARNESS_DEFAULTS, type WorkflowDefinition } from '@graphql/contracts'
import { managementGraphOperations } from './managementDiff'

const base: WorkflowDefinition = {
  id: 'workflow-1', workspaceId: 'workspace-1', name: 'Workflow', executionCondition: { kind: 'manual' },
  nodes: [{ id: 'node-1', agentId: 'agent-1', name: 'Step', position: { x: 0, y: 0 } }], edges: [],
}
const agent = { id: 'agent-1', name: 'Agent', harnessConfiguration: DEFAULT_HARNESS_DEFAULTS.codex }

describe('management graph diff', () => {
  it('emits a complete node replacement without reordering from node movement', () => {
    const movedNode = { ...base.nodes[0]!, position: { x: 10, y: 20 } }
    const operations = managementGraphOperations({
      base, next: { ...base, nodes: [movedNode] },
      baseAgents: [agent], nextAgents: [agent], metadataRevisions: { 'agent-1': 2 },
    })
    expect(operations).toEqual([{ type: 'node.replace', node: movedNode }])
  })

  it('adds a logical agent before configuring its new node', () => {
    const added = { id: 'agent-2', name: 'Second', harness: 'codex' as const, harnessConfiguration: DEFAULT_HARNESS_DEFAULTS.codex }
    const operations = managementGraphOperations({
      base, next: { ...base, nodes: [...base.nodes, { id: 'node-2', agentId: added.id, name: 'Second' }] },
      baseAgents: [agent], nextAgents: [agent, added], metadataRevisions: { 'agent-1': 2 },
    })
    expect(operations.map((item) => item.type)).toEqual([
      'agent.add',
      'agent.configure',
      'node.replace',
      'nodes.reorder',
    ])
  })
})
