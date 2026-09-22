import { describe, expect, it } from 'vitest'
import { makeWave25Fixture } from '@graphql/contracts/wave25'
import { buildExecutableWorkflowVersionV2, migrateSavedWorkflowDefinition } from '../src/modules/workflows/executableVersion.js'
import type { WorkflowVersion } from '@graphql/contracts'

function input() {
  const fixture = makeWave25Fixture('a3-entry')
  return { id: fixture.version.id, definition: fixture.version.definition, configurations: fixture.configurations, createdAt: fixture.createdAt, version: 1 }
}

describe('Agent 3 authored entry acceptance', () => {
  it('starts a sole Worker itself', () => {
    const value = input()
    value.definition.nodes = value.definition.nodes.slice(0, 1)
    value.definition.edges = []
    value.definition.entryNodeId = null
    value.configurations = value.configurations.slice(0, 1)
    const version = buildExecutableWorkflowVersionV2(value)
    expect(version.entryNodeId).toBe(value.definition.nodes[0]!.id)
  })
  it('accepts a sole Orchestrator with legitimate App approval and no artificial Worker', () => {
    const value = input()
    value.definition.nodes = value.definition.nodes.slice(0, 1)
    value.definition.edges = []
    value.definition.entryNodeId = null
    value.configurations = value.configurations.slice(0, 1).map((configuration) => ({ ...configuration, productRole: 'orchestrator' }))
    value.definition.approval = { handler: 'orchestrator', designatedOrchestratorAgentId: value.configurations[0]!.agentId }
    expect(buildExecutableWorkflowVersionV2(value).entryNodeId).toBe(value.definition.nodes[0]!.id)
  })
  it('accepts a sole Orchestrator with explicit human approval', () => {
    const value = input()
    value.definition.nodes = value.definition.nodes.slice(0, 1)
    value.definition.edges = []
    value.definition.entryNodeId = null
    value.configurations = [{ ...value.configurations[0]!, productRole: 'orchestrator' }]
    value.definition.approval = { handler: 'user' }
    expect(buildExecutableWorkflowVersionV2(value).entryNodeId).toBe(value.definition.nodes[0]!.id)
  })
  it('selects one of multiple pinned Orchestrators without array-order authority', () => {
    const value = input()
    value.definition.edges = []
    value.configurations = value.configurations.map((item) => ({ ...item, productRole: 'orchestrator' }))
    value.definition.entryNodeId = value.definition.nodes[1]!.id
    expect(buildExecutableWorkflowVersionV2(value).entryNodeId).toBe(value.definition.nodes[1]!.id)
    value.definition.nodes.reverse()
    expect(buildExecutableWorkflowVersionV2(value).entryNodeId).toBe(value.definition.entryNodeId)
  })
  it('requires a selected Worker for a multi-Worker board', () => {
    const value = input()
    value.definition.entryNodeId = null
    expect(() => buildExecutableWorkflowVersionV2(value)).toThrow()
    value.definition.entryNodeId = value.definition.nodes[0]!.id
    expect(buildExecutableWorkflowVersionV2(value).entryNodeId).toBe(value.definition.entryNodeId)
  })
  it('uses pinned roles, not an Orchestrator label, for a mixed-role board', () => {
    const value = input()
    value.configurations[1] = { ...value.configurations[1]!, productRole: 'orchestrator' }
    value.definition.nodes[0]!.name = 'Orchestrator'
    expect(() => buildExecutableWorkflowVersionV2(value)).toThrow()
    value.definition.edges = []
    value.definition.entryNodeId = value.definition.nodes[1]!.id
    expect(buildExecutableWorkflowVersionV2(value).entryNodeId).toBe(value.definition.nodes[1]!.id)
  })
  it('keeps an authored entry under reorder and rejects its deletion', () => {
    const value = input()
    const entry = value.definition.entryNodeId
    value.definition.nodes.reverse()
    expect(buildExecutableWorkflowVersionV2(value).entryNodeId).toBe(entry)
    value.definition.nodes = value.definition.nodes.filter((node) => node.id !== entry)
    value.definition.edges = []
    expect(() => buildExecutableWorkflowVersionV2(value)).toThrow()
  })
  it('hashes optional draft metadata as its persisted JSON representation', () => {
    const value = input()
    const before = buildExecutableWorkflowVersionV2(value)
    Object.assign(value.definition, { description: undefined })
    Object.assign(value.definition.nodes[0]!, { initialPrompt: undefined })
    expect(buildExecutableWorkflowVersionV2(value).contentHash).toBe(before.contentHash)
    expect(Object.hasOwn(buildExecutableWorkflowVersionV2(value).definition, 'description')).toBe(false)
  })
  it('migrates from the immutable legacy entry without rewriting that legacy record', () => {
    const value = input()
    const { executionSemanticsVersion: _semantics, entryNodeId: _entry, ...definition } = value.definition
    void _semantics; void _entry
    const saved = { ...makeWave25Fixture('a3-entry').version,
      definition: { ...definition, edges: definition.edges.map(({ kind: _kind, ...edge }) => { void _kind; return { ...edge, route: { outcomes: ['succeeded'] } } }) },
    }
    const { executionSemanticsVersion: _versionSemantics, ...legacy } = saved
    void _versionSemantics
    const before = JSON.stringify(legacy)
    const migrated = migrateSavedWorkflowDefinition(legacy as WorkflowVersion)
    expect(migrated.entryNodeId).toBe(legacy.entryNodeId)
    expect(migrated.edges.every((edge) => edge.kind === 'execution')).toBe(true)
    expect(JSON.stringify(legacy)).toBe(before)
  })
})
