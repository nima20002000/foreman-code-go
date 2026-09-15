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

  it('rejects unsupported result routing instead of silently changing it', () => {
    const version = workflowVersion()
    version.definition.edges[0]!.route = {
      outcomes: ['succeeded'],
      result: { path: ['approved'], operator: 'equals', value: true },
    }
    expect(() => validateExecutableTopology(version)).toThrowError(DomainError)
    expect(() => validateExecutableTopology(version)).toThrow('uses routing not supported')
  })
})
