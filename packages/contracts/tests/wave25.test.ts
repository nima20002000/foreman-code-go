import { describe, expect, it } from 'vitest'
import { WorkflowDefinitionSchema, WorkflowRunSchema, WorkflowVersionSchema } from '../src/index.js'
import {
  makeWave25Fixture, ExecutableWorkflowV2Schema, WorkflowVersionV2Schema, WorkflowDefinitionV2Schema,
  CompatibleWorkflowDefinitionSchema, CompatibleWorkflowVersionSchema, CompatibleWorkflowRunSchema,
  WorkflowChoiceSchema, WorkflowRelationshipSchema, parseChoiceResultEnvelope, assertWave25Admission,
  WAVE25_ADMISSION_ENABLED, DISABLED_RUN_GRAPH_CAPABILITIES, NodeResolutionSchema,
  GraphSequenceSchema, GraphFactSchema, RunGraphBatchSchema, RunGraphPageSchema, RunGraphEventSchema, RUN_GRAPH_LIMITS, graphJsonBytes,
  applyRunGraphPageFixture,
} from '../src/wave25/index.js'

const choice = WorkflowChoiceSchema.parse({ outcomes: [
  { outcome: 'pass', target: { kind: 'branch_end' } },
  { outcome: 'issues', target: { kind: 'edge', relationshipId: 'fixer-link' } },
] })

describe('Wave 2.5 compatibility and executable contracts', () => {
  it('keeps legacy strict shapes readable without silently upgrading them', () => {
    const fixture = makeWave25Fixture()
    const { executionSemanticsVersion: _semantics, entryNodeId: _entry, ...legacyDefinition } = fixture.version.definition
    legacyDefinition.edges = fixture.version.definition.edges.map(({ id, source, target }) => ({
      id, source, target, route: { outcomes: ['succeeded'] },
    })) as unknown as typeof legacyDefinition.edges
    const { executionSemanticsVersion: _versionSemantics, ...legacyVersion } = fixture.version
    const oldVersion = { ...legacyVersion, definition: legacyDefinition }
    const { executionSemanticsVersion: _runSemantics, ...legacyRun } = fixture.run
    expect(WorkflowDefinitionSchema.parse(legacyDefinition)).toEqual(legacyDefinition)
    expect(WorkflowVersionSchema.parse(oldVersion)).toEqual(oldVersion)
    expect(WorkflowRunSchema.parse(legacyRun)).toEqual(legacyRun)
    expect(CompatibleWorkflowDefinitionSchema.parse(legacyDefinition)).not.toHaveProperty('executionSemanticsVersion')
    expect(CompatibleWorkflowVersionSchema.parse(oldVersion)).not.toHaveProperty('executionSemanticsVersion')
    expect(CompatibleWorkflowRunSchema.parse(legacyRun)).not.toHaveProperty('executionSemanticsVersion')
    expect(WorkflowVersionSchema.safeParse(fixture.version).success).toBe(false)
    expect(CompatibleWorkflowVersionSchema.parse(fixture.version)).toMatchObject({ executionSemanticsVersion: 2 })
    expect(WAVE25_ADMISSION_ENABLED).toBe(false)
    expect(DISABLED_RUN_GRAPH_CAPABILITIES.protocolVersions).toEqual([])
    expect(() => assertWave25Admission()).toThrow('EXECUTION_SEMANTICS_ROLLOUT_DISABLED')
    // Destructured pins are intentionally removed, not replaced by defaults.
    expect([_semantics, _entry, _versionSemantics, _runSemantics]).toHaveLength(4)
  })
  it('accepts the sole Worker and keeps an explicit multi-Worker entry stable under reorder', () => {
    const fixture = makeWave25Fixture()
    const one = structuredClone(fixture.version)
    one.definition.nodes = [one.definition.nodes[0]!]; one.definition.edges = []
    one.agentConfigurationVersionIds = { [fixture.configurations[0]!.agentId]: fixture.configurations[0]!.id }
    expect(ExecutableWorkflowV2Schema.safeParse({ version: one, configurations: [fixture.configurations[0]] }).success).toBe(true)
    const reordered = structuredClone(fixture.version)
    reordered.definition.nodes.reverse()
    expect(ExecutableWorkflowV2Schema.parse({ version: reordered, configurations: fixture.configurations }).version.entryNodeId).toBe(fixture.version.entryNodeId)
    expect(WorkflowDefinitionV2Schema.safeParse({ ...reordered.definition, entryNodeId: null }).success).toBe(true)
    expect(WorkflowVersionV2Schema.safeParse({ ...reordered, definition: { ...reordered.definition, entryNodeId: null } }).success).toBe(false)
  })
  it('requires an Orchestrator entry when present and permits only the supported initialized reviewer', () => {
    const fixture = makeWave25Fixture()
    fixture.configurations[1]!.productRole = 'orchestrator'
    expect(ExecutableWorkflowV2Schema.safeParse({ version: fixture.version, configurations: fixture.configurations }).success).toBe(false)
    fixture.configurations[1]!.productRole = 'coder'; fixture.configurations[0]!.productRole = 'orchestrator'
    fixture.version.approval = { handler: 'orchestrator', designatedOrchestratorAgentId: fixture.configurations[0]!.agentId }
    fixture.version.definition.approval = fixture.version.approval
    const edge = fixture.version.definition.edges[0]!
    fixture.version.definition.edges.push({ ...edge, id: 'review-authority', kind: 'approval' })
    expect(ExecutableWorkflowV2Schema.safeParse({ version: fixture.version, configurations: fixture.configurations }).success).toBe(true)
    // Even the same visual pair retains two distinct typed relationship records.
    expect(fixture.version.definition.edges.map((item) => item.kind)).toEqual(['execution', 'approval'])
    fixture.version.definition.edges[1] = { ...edge, id: 'wrong-reviewer', kind: 'approval', source: edge.target, target: edge.source }
    expect(ExecutableWorkflowV2Schema.safeParse({ version: fixture.version, configurations: fixture.configurations }).success).toBe(false)
  })
  it('does not count approval-only relationships as execution dependencies', () => {
    const fixture = makeWave25Fixture()
    const edge = fixture.version.definition.edges[0]!
    fixture.version.definition.edges = [{ ...edge, id: 'reverse-approval', kind: 'approval', source: edge.target, target: edge.source }]
    expect(WorkflowVersionV2Schema.safeParse(fixture.version).success).toBe(true)
    expect(WorkflowRelationshipSchema.safeParse({ ...edge, kind: 'coordination' }).success).toBe(false)
    expect(WorkflowRelationshipSchema.safeParse({ ...edge, route: { outcomes: ['succeeded'] } }).success).toBe(false)
    fixture.version.definition.edges = [{ ...edge, source: edge.target, target: edge.source }]
    expect(WorkflowVersionV2Schema.safeParse(fixture.version).success).toBe(false)
  })
  it('rejects unknown permission settings rather than falling back to a broader configuration', () => {
    const fixture = makeWave25Fixture()
    const configurations = fixture.configurations.map((configuration) => ({ ...configuration,
      harness: { ...configuration.harness, sandbox: 'unknown-security-mode' },
    }))
    expect(ExecutableWorkflowV2Schema.safeParse({ version: fixture.version, configurations }).success).toBe(false)
  })
})

describe('finite choice outcomes and one-shot resolutions', () => {
  it.each(['pass', 'issues'])('accepts the complete declared %s envelope', (outcome) => {
    const output = { routing: { outcome }, data: { summary: 'Synthetic result' } }
    expect(parseChoiceResultEnvelope({ outcome: 'succeeded', output }, choice)).toEqual(output)
    expect(parseChoiceResultEnvelope({ outcome: 'succeeded', output: JSON.stringify(output) }, choice)).toEqual(output)
  })
  it.each(['pass', '```json\n{"routing":{"outcome":"pass"},"data":{}}\n```', '{"routing":{"outcome":"other"},"data":{}}', '{"routing":{"outcome":"pass"}}', '{"routing":{"outcome":"pass"},"data":{}} trailing'])('has no prose, malformed, undeclared or partial fallback: %s', (output) => {
    expect(() => parseChoiceResultEnvelope({ outcome: 'succeeded', output }, choice)).toThrow()
  })
  it('validates declarations and never treats skipped/failed/unknown as accepted success', () => {
    expect(WorkflowChoiceSchema.safeParse({ outcomes: [...choice.outcomes, choice.outcomes[0]] }).success).toBe(false)
    expect(() => parseChoiceResultEnvelope({ outcome: 'canceled' }, choice)).toThrow()
    const fixture = makeWave25Fixture()
    const resolution = { workflowNodeId: fixture.identities[0]!.workflowNodeId, resolution: 'skipped', branchEnded: false,
      selectedRelationshipIds: [], unselectedRelationshipIds: [fixture.version.definition.edges[0]!.id], resolvedAt: fixture.createdAt }
    expect(NodeResolutionSchema.safeParse(resolution).success).toBe(true)
    expect(NodeResolutionSchema.safeParse({ ...resolution, execution: fixture.identities[0] }).success).toBe(false)
    expect(NodeResolutionSchema.safeParse({ ...resolution, resolution: 'unknown' }).success).toBe(false)
    expect(NodeResolutionSchema.safeParse({ ...resolution, resolution: 'succeeded' }).success).toBe(false)
  })
})

describe('complete graph pages, identity and safe facts', () => {
  it('preserves decimal cursors above the JS safe integer limit', () => {
    expect(GraphSequenceSchema.parse('9007199254740993')).toBe('9007199254740993')
    for (const value of [9007199254740992, '01', '-1', '1.0', '9223372036854775808']) expect(GraphSequenceSchema.safeParse(value).success).toBe(false)
  })
  it('bounds complete batches by bytes as well as count, without accepting JSON prefixes', () => {
    const fixture = makeWave25Fixture(), long = 'x'.repeat(200)
    const identity = { workflowNodeId: long, executionId: long, agentId: long, agentConfigurationVersionId: long, attempt: 1 }
    const event = { eventId: '00000000-0000-4000-8000-000000000001',
      evidence: { sourceKind: 'execution', sourceId: long, sourceRevision: '0' },
      fact: { type: 'node.state', state: { workflowNodeId: long, lifecycle: 'starting', execution: identity } } }
    expect(RunGraphEventSchema.safeParse(event).success).toBe(true)
    const batch = { protocolVersion: 1, scope: fixture.scope, batchId: '00000000-0000-4000-8000-000000000100', previousSequence: '0', sequence: '1',
      events: Array.from({ length: RUN_GRAPH_LIMITS.batchEvents }, (_, i) => ({ ...event, eventId: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}` })) }
    expect(graphJsonBytes(batch)).toBeGreaterThan(RUN_GRAPH_LIMITS.batchBytes)
    expect(RunGraphBatchSchema.safeParse(batch).success).toBe(false)
    expect(RunGraphBatchSchema.safeParse(JSON.stringify(batch).slice(0, 500)).success).toBe(false)
  })
  it('rejects partial cursor advancement, unsupported atomic content and raw bodies', () => {
    const fixture = makeWave25Fixture()
    const batch = RunGraphBatchSchema.parse({ protocolVersion: 1, scope: fixture.scope,
      batchId: '00000000-0000-4000-8000-000000000001', previousSequence: '9007199254740992', sequence: '9007199254740993',
      events: [{ eventId: '00000000-0000-4000-8000-000000000002', evidence: { sourceKind: 'run', sourceId: fixture.run.id, sourceRevision: '1' },
        fact: { type: 'run.state', state: fixture.snapshot.state.run } }],
    })
    const page = { kind: 'page', protocolVersion: 1, scope: fixture.scope, baseSequence: batch.previousSequence, throughSequence: batch.sequence,
      headSequence: batch.sequence, retentionFloor: '0', hasMore: false, batches: [batch] }
    expect(RunGraphPageSchema.safeParse(page).success).toBe(true)
    expect(RunGraphPageSchema.safeParse({ ...page, batches: [] }).success).toBe(false)
    expect(RunGraphBatchSchema.safeParse({ ...batch, events: [...batch.events, ...batch.events] }).success).toBe(false)
    expect(GraphFactSchema.safeParse({ type: 'run.state', state: fixture.snapshot.state.run, rawBody: 'secret' }).success).toBe(false)
    expect(GraphFactSchema.safeParse({ type: 'transport.keepalive' }).success).toBe(false)
    expect(GraphFactSchema.safeParse({ type: 'node.activity', activity: { workflowNodeId: fixture.identities[0]!.workflowNodeId, status: 'active', action: 'working' } }).success).toBe(false)
  })
})

// Retained from the original bundle; imports and the erroneous copied errors module are repaired.
describe('compact settled-exchange retirement', () => {
  it('removes a settled current-window record, not domain history, and never infers Worker resumption', () => {
    const fixture = makeWave25Fixture()
    fixture.snapshot.state.interactions = [{ interactionId: 'settled-interaction', revision: '1', requester: fixture.identities[0]!, handler: 'user', status: 'canceled', deliveryState: 'not_started', resumeState: 'not_started' }]
    const publication = RunGraphBatchSchema.parse({
      protocolVersion: 1, scope: fixture.scope, batchId: '00000000-0000-4000-8000-000000000001', previousSequence: '0', sequence: '1',
      events: [{ eventId: '00000000-0000-4000-8000-000000000002', evidence: { sourceKind: 'cleanup', sourceId: 'cleanup-confirmed', sourceRevision: '1' }, fact: { type: 'exchange.retired', exchangeKind: 'interaction', exchangeId: 'settled-interaction', finalRevision: '1' } }],
    })
    const page = { kind: 'page', protocolVersion: 1, scope: fixture.scope, baseSequence: '0', throughSequence: '1', headSequence: '1', retentionFloor: '0', hasMore: false, batches: [publication] }
    const applied = applyRunGraphPageFixture(fixture.snapshot, page, 1, 1)
    expect(applied.kind).toBe('applied')
    expect(applied.snapshot.state.interactions).toEqual([])
    expect(applied.snapshot.state.nodes).toBe(fixture.snapshot.state.nodes)
    fixture.snapshot.state.interactions[0]!.status = 'pending'
    expect(applyRunGraphPageFixture(fixture.snapshot, page, 1, 1).kind).toBe('reset')
  })
})
