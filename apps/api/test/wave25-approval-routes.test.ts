import { describe, expect, it } from 'vitest'
import { resolveImmutableApprovalRoute, usesNativeSelfReview } from '../src/modules/workflows/approvalRoutes.js'
import { acceptedRunApproval, validateExecutableApprovalRoutes } from '../src/modules/workflows/approval.js'
import { validateReviewerBootstrap } from '../src/modules/workflows/reviewerBootstrap.js'
import { deriveLegacyApprovalRelationships } from '../src/modules/workflows/approvalMigration.js'
import { approvalFixture, legacyApprovalFixture, routeDenialCases } from './helpers/wave25ApprovalFixture.js'

function route(version = approvalFixture().version) {
  return resolveImmutableApprovalRoute(version, 'node-worker', 'agent-worker')
}

describe('Wave 2.5 immutable approval routing', () => {
  it('returns the typed relationship and exact immutable node/configuration pins', () => {
    expect(route()).toEqual({
      workspaceId: 'workspace-approval', workflowId: 'workflow-approval', workflowVersionId: 'version-approval',
      requestingNodeId: 'node-worker', requestingAgentId: 'agent-worker', requestingConfigurationVersionId: 'cfg-worker',
      orchestratorNodeId: 'node-reviewer', reviewerAgentId: 'agent-reviewer', reviewerConfigurationVersionId: 'cfg-reviewer',
      relationshipId: 'approval-edge',
    })
  })
  it.each(routeDenialCases)('denies %s', (_name, mutate) => {
    const { version } = approvalFixture()
    mutate(version)
    expect(route(version)).toBeUndefined()
  })
  it.each([
    ['missing-node', 'agent-worker'], ['node-worker', 'wrong-agent'], ['node-reviewer', 'agent-reviewer'],
  ])('denies mismatched or self requester %s/%s', (nodeId, agentId) => {
    expect(resolveImmutableApprovalRoute(approvalFixture().version, nodeId, agentId)).toBeUndefined()
  })
  it('does not use canvas order, labels, or a current draft', () => {
    const { version } = approvalFixture()
    const before = route(version)
    version.definition.nodes.reverse()
    version.definition.nodes[0]!.name = 'Orchestrator'
    version.definition.edges.reverse()
    expect(route(version)).toEqual(before)
    const draft = structuredClone(version.definition)
    draft.edges = []
    expect(route(version)).toEqual(before)
  })
  it('rejects an inherited rather than pinned configuration ID', () => {
    const { version } = approvalFixture()
    version.agentConfigurationVersionIds = Object.create(version.agentConfigurationVersionIds) as Record<string, string>
    expect(route(version)).toBeUndefined()
  })
  it('uses accepted entry rather than nodes[0] in reviewer bootstrap', () => {
    const { version, configurations } = approvalFixture()
    version.definition.nodes.reverse()
    expect(() => validateReviewerBootstrap(version.definition, version.approval, configurations[0]!.harness, version.entryNodeId)).not.toThrow()
    expect(() => validateReviewerBootstrap(version.definition, version.approval, configurations[0]!.harness, 'node-worker')).toThrow()
  })
  it('accepts safe one-node native self-review without an App self-edge or artificial Worker', () => {
    const { version, configurations } = approvalFixture()
    version.definition.nodes = version.definition.nodes.slice(0, 1)
    version.definition.edges = []
    version.agentConfigurationVersionIds = { 'agent-reviewer': 'cfg-reviewer' }
    expect(usesNativeSelfReview(configurations[0]!.harness)).toBe(true)
    expect(validateExecutableApprovalRoutes(version, configurations.slice(0, 1))).toEqual([])
    expect(resolveImmutableApprovalRoute(version, 'node-reviewer', 'agent-reviewer')).toBeUndefined()
  })
  it('keeps unsafe or missing native bootstrap configuration rejected', () => {
    const { version, configurations } = approvalFixture()
    expect(() => validateReviewerBootstrap(version.definition, version.approval, undefined)).toThrow()
    expect(() => validateReviewerBootstrap(version.definition, version.approval, configurations[1]!.harness)).toThrow()
  })
  it('validates immutable configurations and routes at executable acceptance', () => {
    const { version, configurations } = approvalFixture()
    expect(validateExecutableApprovalRoutes(version, configurations)).toEqual([route(version)])
    const wrong = structuredClone(configurations)
    wrong[0]!.workspaceId = 'different-workspace'
    expect(() => validateExecutableApprovalRoutes(version, wrong)).toThrow()
    const stale = structuredClone(configurations)
    stale[0]!.id = 'stale-configuration'
    expect(() => validateExecutableApprovalRoutes(version, stale)).toThrow()
    const wrongRole = structuredClone(configurations)
    wrongRole[0]!.productRole = 'coder'
    expect(() => validateExecutableApprovalRoutes(version, wrongRole)).toThrow()
  })
  it('accepts a native self-review Worker without inventing an App assignment (G1 conflict)', () => {
    const { version, configurations } = approvalFixture()
    configurations[1]!.harness = structuredClone(configurations[0]!.harness)
    version.definition.edges = version.definition.edges.filter((e) => e.kind === 'execution')
    // Intentionally unskipped: the frozen G1 schema currently rejects this case.
    // The terminal must resolve that shared-contract conflict; do not relax local checks.
    expect(validateExecutableApprovalRoutes(version, configurations)).toEqual([])
  })
  it('rejects recursive approval snapshots before dispatch', () => {
    const { version } = approvalFixture()
    version.definition.edges.push({ id: 'cycle', kind: 'approval', source: 'node-worker', target: 'node-reviewer' })
    expect(() => acceptedRunApproval(version)).toThrow()
  })
})

describe('Legacy approval derivation', () => {
  it.each([false, true])('preserves exact legacy execution direction, reverse=%s', (reverse) => {
    const { version, configurations } = legacyApprovalFixture()
    if (reverse) Object.assign(version.definition.edges[0]!, { source: 'node-worker', target: 'node-reviewer' })
    const before = structuredClone(version)
    expect(resolveImmutableApprovalRoute(version, 'node-worker', 'agent-worker')).toBeDefined()
    const records = deriveLegacyApprovalRelationships(version, configurations)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ kind: 'approval', source: 'node-reviewer', target: 'node-worker' })
    expect(version).toEqual(before)
    expect(deriveLegacyApprovalRelationships(version, configurations)).toEqual(records)
  })
  it('does not manufacture authority from transitive adjacency or current configuration', () => {
    const { version, configurations } = legacyApprovalFixture()
    version.definition.edges = []
    expect(() => deriveLegacyApprovalRelationships(version, configurations)).toThrow()
    const stale = legacyApprovalFixture()
    stale.configurations[0]!.id = 'current-not-accepted-config'
    expect(() => deriveLegacyApprovalRelationships(stale.version, stale.configurations)).toThrow()
  })
  it('never adds an App assignment for native self-review', () => {
    const { version, configurations } = legacyApprovalFixture()
    configurations[1]!.harness = structuredClone(configurations[0]!.harness)
    expect(deriveLegacyApprovalRelationships(version, configurations)).toEqual([])
  })
  it('rejects mixed typed records on a legacy version', () => {
    const { version } = legacyApprovalFixture()
    Object.assign(version.definition.edges[0]!, { kind: 'execution' })
    expect(resolveImmutableApprovalRoute(version, 'node-worker', 'agent-worker')).toBeUndefined()
  })
  it('preserves explicit user handling with no inferred reviewer', () => {
    const { version, configurations } = legacyApprovalFixture()
    version.approval = { handler: 'user' }
    version.definition.approval = { handler: 'user' }
    expect(deriveLegacyApprovalRelationships(version, configurations)).toEqual([])
  })
})
