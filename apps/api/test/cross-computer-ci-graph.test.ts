import { describe, expect, it } from 'vitest'
import type { WorkflowDefinitionV3 } from '@foreman-code/contracts/wave25'
import { buildCrossComputerCiGraph, projectSuites, type ScenarioAgent } from './helpers/crossComputerCiGraph.js'

const mainId = '11111111-1111-4111-8111-111111111111'
const base: WorkflowDefinitionV3 = {
  id: 'workflow', workspaceId: 'workspace', name: 'CI', executionSemanticsVersion: 3,
  entryNodeId: null, executionCondition: { kind: 'manual' }, nodes: [], edges: [],
}
function assignment(index: number, suite: ScenarioAgent['suite']): ScenarioAgent {
  return {
    agentId: `agent-${index}`, nodeId: `node-${index}`, name: `Agent ${index}`, suite,
    profile: {
      instanceId: '22222222-2222-4222-8222-222222222222', instanceRevision: '1',
      target: { hostRef: { kind: 'main', mainId }, applicationInstallationId: mainId,
        harnessInstallationId: 'codex', installationFingerprint: 'codex-installed' },
    },
  }
}

describe('cross-computer CI graph', () => {
  it.each(['graphql', 'demo'] as const)('starts every %s suite as an independent parallel Agent', project => {
    const assignments = [assignment(0, null), ...projectSuites[project].map((suite, index) => assignment(index + 1, suite))]
    const { graph, agents } = buildCrossComputerCiGraph(base, assignments)
    expect(graph.entryNodeId).toBe('node-0')
    expect(graph.executionPolicy).toEqual({ maxParallelism: 3, maxNodeExecutions: 4 })
    expect(graph.edges.map(edge => [edge.source, edge.target])).toEqual([
      ['node-0', 'node-1'], ['node-0', 'node-2'], ['node-0', 'node-3'],
    ])
    expect(graph.nodes.map(node => node.kind === 'job' ? null : node.agentId)).toEqual(agents.map(agent => agent.id))
    expect(graph).not.toHaveProperty('repeat')
    expect(agents.every(agent => agent.harnessConfiguration?.harness === 'codex'
      && agent.harnessConfiguration.sandbox === 'workspace-write')).toBe(true)
    for (const [index, suite] of projectSuites[project].entries()) {
      const node = graph.nodes[index + 1]!
      if (node.kind === 'job') throw new Error('The CI scenario uses Agent nodes.')
      expect(node.initialPrompt).toContain(`suite ${suite}`)
      expect(node.initialPrompt).toContain('run.state is passed, failed, canceled or lost')
    }
    expect(base.nodes).toEqual([])
  })

  it('retains the selected computer and approved source/root for every Agent', () => {
    const worker = assignment(1, 'build')
    worker.placement = {
      schemaVersion: 1, hostRef: { kind: 'device', mainId, deviceId: '33333333-3333-4333-8333-333333333333' },
      rootPolicyId: 'root', rootPolicyRevision: '1', locationRevision: '5', projectRoot: '/approved/project',
      cwdPolicy: 'project-root', relativeCwd: '', instanceId: worker.profile.instanceId,
      instanceRevision: worker.profile.instanceRevision, harnessInstallationId: 'codex',
    }
    const { graph } = buildCrossComputerCiGraph(base, [assignment(0, null), worker])
    const node = graph.nodes[1]!
    expect(node.kind === 'job' ? null : node.placement).toEqual(worker.placement)
  })

  it('rejects an empty, duplicate or non-coordinator entry assignment', () => {
    expect(() => buildCrossComputerCiGraph(base, [])).toThrow('entry coordinator')
    expect(() => buildCrossComputerCiGraph(base, [assignment(0, 'build'), assignment(1, 'lint')]))
      .toThrow('entry coordinator')
    expect(() => buildCrossComputerCiGraph(base, [assignment(0, null), assignment(0, 'build')]))
      .toThrow('separate Agent and node identity')
  })
})
