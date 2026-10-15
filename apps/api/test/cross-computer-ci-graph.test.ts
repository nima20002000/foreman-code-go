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
  it('enforces judgments without copied identifiers in the Agent output schema', () => {
    const { graph } = buildCrossComputerCiGraph(base, [assignment(0, null), assignment(1, 'build')])
    const node = graph.nodes[1]!
    if (node.kind === 'job') throw new Error('Expected a CI Agent')
    expect(node.outputSchema).toMatchObject({
      required: ['suite', 'outcome', 'repository', 'logLine', 'observedStates'],
      additionalProperties: false,
    })
    expect(node.outputSchema?.properties).not.toHaveProperty('ticketId')
    expect(node.initialPrompt).toContain('group-terminal')
    expect(node.initialPrompt).toContain('logTail false')
    expect(node.initialPrompt).toContain('ci_logs_read')
  })

  it.each(['graphql', 'demo'] as const)('starts every %s suite as an independent parallel Agent', project => {
    const assignments = [assignment(0, null), ...projectSuites[project].map((suite, index) => assignment(index + 1, suite))]
    const { graph, agents } = buildCrossComputerCiGraph(base, assignments)
    expect(graph.entryNodeId).toBe('node-0')
    expect(graph.executionPolicy).toEqual({ maxParallelism: 3, maxNodeExecutions: 4,
      agentActiveTimeoutMs: 4 * 60 * 60_000 })
    expect(graph.edges.map(edge => [edge.source, edge.target])).toEqual([
      ['node-0', 'node-1'], ['node-0', 'node-2'], ['node-0', 'node-3'],
    ])
    expect(graph.nodes.map(node => node.kind === 'job' ? null : node.agentId)).toEqual(agents.map(agent => agent.id))
    expect(graph).not.toHaveProperty('repeat')
    for (const agent of agents) {
      expect(agent.harnessConfiguration).toMatchObject({ harness: 'codex', sandbox: 'workspace-write',
        model: 'gpt-6-luna', reasoningEffort: 'medium' })
      expect(agent.graphqlTools).toEqual(expect.arrayContaining(['context_get', 'ci_computers_list', 'ci_run',
        'ci_get', 'ci_logs_read']))
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
