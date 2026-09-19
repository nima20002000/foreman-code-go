import { describe, expect, it } from 'vitest'

import { WorkflowVersionSchema, type WorkflowVersion } from '@graphql/contracts'

import { DomainError } from '../src/modules/errors.js'
import { validateExecutableTopology } from '../src/modules/runs/topology.js'

function workflowVersion(): WorkflowVersion {
  return WorkflowVersionSchema.parse({
    id: 'workflow-1-v1',
    workspaceId: 'workspace-1',
    workflowId: 'workflow-1',
    version: 1,
    entryNodeId: 'node-a',
    definition: {
      id: 'workflow-1',
      workspaceId: 'workspace-1',
      name: 'Test',
      executionCondition: { kind: 'manual' },
      requiredAgentCount: 3,
      version: 1,
      executionPolicy: { maxParallelism: 2, maxNodeExecutions: 3 },
      nodes: [
        { id: 'node-a', agentId: 'agent-a', name: 'A', position: { x: 900, y: 0 } },
        { id: 'node-b', agentId: 'agent-b', name: 'B', position: { x: 0, y: 0 } },
        { id: 'node-c', agentId: 'agent-c', name: 'C', join: { mode: 'all' } },
      ],
      edges: [
        { id: 'a-c', source: 'node-a', target: 'node-c', route: { outcomes: ['succeeded'] } },
        { id: 'b-c', source: 'node-b', target: 'node-c', route: { outcomes: ['succeeded'] } },
        { id: 'a-b', source: 'node-a', target: 'node-b', route: { outcomes: ['succeeded'] } },
      ],
    },
    agentConfigurationVersionIds: {
      'agent-a': 'config-a',
      'agent-b': 'config-b',
      'agent-c': 'config-c',
    },
    contentHash: 'sha256:test',
    createdAt: '2026-09-14T00:00:00.000Z',
  })
}

describe('LangGraph topology validation', () => {
  it('uses the explicit entry point rather than canvas position', () => {
    const topology = validateExecutableTopology(workflowVersion())
    expect(topology.outgoing.get('node-a')).toEqual(['node-c', 'node-b'])
    expect(topology.incoming.get('node-c')).toEqual(['node-a', 'node-b'])
    expect(topology.sinks).toEqual(['node-c'])
  })

  it.each(['source', 'target'] as const)('rejects an unknown edge %s before building adjacency', (endpoint) => {
    const version = workflowVersion()
    version.definition.edges[0]![endpoint] = 'missing-node'

    expect(() => validateExecutableTopology(version)).toThrow('references an unknown node')
  })

  it('rejects a missing all join at a fan-in', () => {
    const version = workflowVersion()
    delete version.definition.nodes[2]!.join

    expect(() => validateExecutableTopology(version)).toThrow('must use an all join')
  })

  it('rejects an unreachable node even when all edge endpoints exist', () => {
    const version = workflowVersion()
    version.definition.edges = version.definition.edges.filter((edge) => edge.id !== 'a-b')

    expect(() => validateExecutableTopology(version)).toThrow('Every workflow node must be reachable')
  })

  it('rejects a reachable cycle instead of treating it as a terminal graph', () => {
    const version = workflowVersion()
    version.definition.edges.push({
      ...version.definition.edges[0]!, id: 'c-a', source: 'node-c', target: 'node-a',
    })

    expect(() => validateExecutableTopology(version)).toThrow('Cycles and bounded repeats are not supported')
  })

  it('rejects unsupported result routing instead of silently changing it', () => {
    const version = workflowVersion()
    version.definition.edges[0]!.route = {
      outcomes: ['succeeded'],
      result: { path: ['approved'], operator: 'equals', value: true },
    }
    expect(() => validateExecutableTopology(version)).toThrowError(DomainError)
    expect(() => validateExecutableTopology(version)).toThrow('uses routing not supported')
  })

  it('rejects a graph that no longer matches its declared agent count', () => {
    const version = workflowVersion()
    version.definition.nodes[2] = { ...version.definition.nodes[2]!, agentId: 'agent-b' }

    expect(() => validateExecutableTopology(version)).toThrowError(DomainError)
    expect(() => validateExecutableTopology(version)).toThrow('requires exactly 3 agents but references 2')
  })
})
