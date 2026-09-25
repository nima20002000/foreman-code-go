import { describe, expect, it } from 'vitest'
import { WorkflowVersionSchema } from '../index.js'
import {
  CompatibleWorkflowVersionSchema, ExecutableWorkflowV2Schema, ExecutionSemanticsVersionSchema,
  RunGraphScopeSchema, WorkflowVersionV2Schema, makeWave25Fixture, parseChoiceResultEnvelope,
  REPEAT_CONTRACT_VERSION, REPEAT_EXECUTION_SEMANTICS_VERSION,
  RepeatBlockV1Schema, RepeatPlanV1Schema, RepeatWorkflowVersionV1Schema,
  RepeatExitDataV1Schema, RepeatOccurrenceV1Schema, RepeatDecisionV1Schema, RepeatDecisionMetadataV1Schema,
  parseRepeatExitResultV1, validateRepeatDecisionV1, validateRepeatSuccessorV1,
  type RepeatWorkflowVersionV1, type RepeatOccurrenceV1, type RepeatDecisionV1,
} from './index.js'

const time = '2026-09-25T00:00:00.000Z'
const digest = (index = 1) => `sha256:${index.toString(16).padStart(64, '0')}`
const edge = (source: string, target: string) => ({ id: `${source}-${target}`, kind: 'execution' as const, source, target })
function candidate(maxOccurrences = 3): RepeatWorkflowVersionV1 {
  const baseline = makeWave25Fixture('repeat-a0').version
  const names = ['work', 'review', 'done', 'limit']
  return {
    ...baseline, executionSemanticsVersion: 3, entryNodeId: 'work',
    agentConfigurationVersionIds: Object.fromEntries(names.map((id) => [`agent-${id}`, `config-${id}`])),
    definition: {
      ...baseline.definition, executionSemanticsVersion: 3, entryNodeId: 'work',
      executionPolicy: { maxParallelism: 2, maxNodeExecutions: 2 * maxOccurrences + 2 },
      nodes: names.map((id) => ({ id, agentId: `agent-${id}`, name: id, ...(id === 'review' ? { choice: { outcomes: [
        { outcome: 'pass', target: { kind: 'edge' as const, relationshipId: 'review-done' } },
        { outcome: 'issues', target: { kind: 'edge' as const, relationshipId: 'review-limit' } },
      ] } } : {}) })),
      edges: [edge('work', 'review'), edge('review', 'done'), edge('review', 'limit')],
      repeat: { contractVersion: 1, blocks: [{
        id: 'review-fix', nodeIds: ['work', 'review'], entryNodeId: 'work', exitNodeId: 'review',
        maxOccurrences, repeatOutcome: 'issues', earlyExitOutcome: 'pass',
        limitExit: { kind: 'edge', relationshipId: 'review-limit' },
      }] },
    },
  }
}
const block = (version: RepeatWorkflowVersionV1) => version.definition.repeat.blocks[0]!
function occurrence(index = 1, runId = 'run-repeat'): RepeatOccurrenceV1 {
  const version = candidate()
  return {
    contractVersion: 1,
    identity: { scope: {
      workspaceId: version.workspaceId, workflowId: version.workflowId, workflowVersionId: version.id,
      runId, executionSemanticsVersion: 3,
    }, blockId: 'review-fix', occurrenceId: `occ-${runId}-${index}`, occurrenceIndex: index },
    input: { bindingId: `input-${runId}-${index}`, inputDigest: digest(index + 10), previous: index === 1 ? null : {
      occurrenceId: `occ-${runId}-${index - 1}`, occurrenceIndex: index - 1,
      decisionId: `decision-${runId}-${index - 1}`, acceptedResultDigest: digest(index - 1),
    } },
  }
}
function evidence(index = 1, outcome = 'issues', max = 3) {
  const version = candidate(max), record = occurrence(index)
  const resultData = { latestDeliverable: { revision: index, text: 'latest result' }, remainingFindings: outcome === 'pass' ? [] : [{ id: 'f1', text: 'needs revision' }] }
  const reason = outcome === 'pass' ? 'early_exit' : index === max ? 'limit_exit' : 'repeat'
  const decision: RepeatDecisionV1 = {
    contractVersion: 1, decisionId: `decision-run-repeat-${index}`, occurrence: record,
    exitExecution: { workflowNodeId: 'review', agentId: 'agent-review', agentConfigurationVersionId: 'config-review',
      executionId: `execution-review-${index}`, attempt: 1, occurrence: structuredClone(record.identity) },
    acceptedResultDigest: digest(index), outcome, reason,
    target: reason === 'repeat' ? { kind: 'next_occurrence', entryNodeId: 'work', occurrenceIndex: index + 1 }
      : { kind: 'edge', relationshipId: reason === 'early_exit' ? 'review-done' : 'review-limit' },
    resultData, decidedAt: time,
  }
  const result = { outcome: 'succeeded' as const, output: { routing: { outcome }, data: resultData } }
  return { version, decision, result }
}

const invalidVersions: Array<[string, (value: RepeatWorkflowVersionV1) => void]> = [
  ['old top-level semantics', (v) => { Object.assign(v, { executionSemanticsVersion: 2 }) }],
  ['old definition semantics', (v) => { Object.assign(v.definition, { executionSemanticsVersion: 2 }) }],
  ['unknown contract version', (v) => { Object.assign(v.definition.repeat, { contractVersion: 2 }) }],
  ['missing plan', (v) => { Object.assign(v.definition, { repeat: undefined }) }],
  ['nested blocks field', (v) => { Object.assign(block(v), { blocks: [] }) }],
  ['parent block reference', (v) => { Object.assign(block(v), { parentBlockId: 'outer' }) }],
  ['general expression', (v) => { Object.assign(block(v), { until: 'findings.length === 0' }) }],
  ['duplicate block', (v) => { v.definition.repeat.blocks.push(structuredClone(block(v))) }],
  ['overlapping scopes', (v) => { v.definition.repeat.blocks.push({ ...block(v), id: 'other' }) }],
  ['nested membership', (v) => { v.definition.repeat.blocks.push({ ...block(v), id: 'inner', nodeIds: ['review'], entryNodeId: 'review' }) }],
  ['duplicate member', (v) => { block(v).nodeIds.push('work') }],
  ['missing boundary member', (v) => { block(v).nodeIds = ['work'] }],
  ['unknown member', (v) => { block(v).nodeIds.push('missing') }],
  ['identical outcomes', (v) => { block(v).earlyExitOutcome = 'issues' }],
  ['undeclared early exit', (v) => { block(v).earlyExitOutcome = 'approved' }],
  ['mismatched explicit limit route', (v) => { block(v).limitExit = { kind: 'edge', relationshipId: 'review-done' } }],
  ['missing explicit limit route', (v) => { Object.assign(block(v), { limitExit: undefined }) }],
  ['extra exit outcome', (v) => { v.definition.nodes[1]!.choice!.outcomes.push({ outcome: 'maybe', target: { kind: 'branch_end' } }) }],
  ['undeclared choice edge', (v) => { v.definition.edges.push(edge('review', 'work')) }],
  ['general execution cycle', (v) => { v.definition.edges.push(edge('limit', 'work')) }],
  ['side exit', (v) => { v.definition.edges.push(edge('work', 'done')) }],
  ['exit re-enters its own scope', (v) => { block(v).nodeIds.push('done') }],
  ['disconnected body', (v) => { v.definition.edges.shift() }],
  ['interior branch end', (v) => { v.definition.nodes[0]!.choice = { outcomes: [
    { outcome: 'go', target: { kind: 'edge', relationshipId: 'work-review' } }, { outcome: 'skip', target: { kind: 'branch_end' } },
  ] } }],
  ['missing Agent pin', (v) => { delete v.agentConfigurationVersionIds['agent-review'] }],
  ['mismatched saved scope', (v) => { v.definition.workspaceId = 'other' }],
  ['mismatched saved revision', (v) => { v.definition.version = 99 }],
  ['mismatched saved approval', (v) => { v.definition.approval = { handler: 'orchestrator', designatedOrchestratorAgentId: 'agent-work' } }],
  ['insufficient complete business budget', (v) => { v.definition.executionPolicy!.maxNodeExecutions = 4 }],
]

describe('ENG-04 A0 bounded-repeat version-1 candidate contract, not runtime admission', () => {
  it('exports fixed contract and reserved execution-semantic versions', () => {
    expect(REPEAT_CONTRACT_VERSION).toBe(1); expect(REPEAT_EXECUTION_SEMANTICS_VERSION).toBe(3)
  })
  it.each([1, 2, 10])('accepts an explicit cap of %i total business occurrences', (max) => {
    expect(RepeatWorkflowVersionV1Schema.parse(candidate(max))).toEqual(candidate(max))
  })
  it('accepts a single-node scope and an explicit branch-end limit', () => {
    const v = candidate(); block(v).nodeIds = ['review']; block(v).entryNodeId = 'review'
    block(v).limitExit = { kind: 'branch_end' }
    v.definition.nodes[1]!.choice!.outcomes[1]!.target = { kind: 'branch_end' }
    v.definition.edges = v.definition.edges.filter((item) => item.id !== 'review-limit')
    expect(RepeatWorkflowVersionV1Schema.safeParse(v).success).toBe(true)
  })
  it('accepts two disjoint serial scopes without a hierarchy', () => {
    const v = candidate()
    v.definition.nodes[2]!.choice = { outcomes: [
      { outcome: 'pass', target: { kind: 'branch_end' } }, { outcome: 'issues', target: { kind: 'branch_end' } },
    ] }
    v.definition.repeat.blocks.push({ ...block(v), id: 'second', nodeIds: ['done'], entryNodeId: 'done', exitNodeId: 'done', maxOccurrences: 2, limitExit: { kind: 'branch_end' } })
    v.definition.executionPolicy!.maxNodeExecutions = 9
    expect(RepeatWorkflowVersionV1Schema.safeParse(v).success).toBe(true)
  })
  it('accepts uneven conditional paths and an inherited all-required join within one scope', () => {
    const v = candidate(), names = ['short', 'long1', 'long2']
    for (const id of names) {
      v.definition.nodes.push({ id, agentId: `agent-${id}`, name: id })
      v.agentConfigurationVersionIds[`agent-${id}`] = `config-${id}`
    }
    v.definition.nodes[0]!.choice = { outcomes: [
      { outcome: 'short', target: { kind: 'edge', relationshipId: 'work-short' } },
      { outcome: 'long', target: { kind: 'edge', relationshipId: 'work-long1' } },
    ] }
    v.definition.nodes[1]!.join = { mode: 'all' }
    v.definition.edges = [...v.definition.edges.slice(1), edge('work', 'short'), edge('short', 'review'), edge('work', 'long1'), edge('long1', 'long2'), edge('long2', 'review')]
    block(v).nodeIds.push(...names); v.definition.executionPolicy!.maxNodeExecutions = 17
    expect(RepeatWorkflowVersionV1Schema.safeParse(v).success).toBe(true)
  })
  it('explicitly rejects a side entry even in an otherwise valid acyclic graph', () => {
    const v = candidate()
    v.entryNodeId = 'outside'; v.definition.entryNodeId = 'outside'
    v.definition.nodes.push({ id: 'outside', agentId: 'agent-outside', name: 'Outside' })
    v.agentConfigurationVersionIds['agent-outside'] = 'config-outside'
    v.definition.edges.push(edge('outside', 'work'), edge('outside', 'review'))
    v.definition.executionPolicy!.maxNodeExecutions++
    expect(() => RepeatWorkflowVersionV1Schema.parse(v)).toThrow('REPEAT_SIDE_ENTRY_UNSUPPORTED')
  })
  it.each(invalidVersions)('rejects %s', (_name, mutate) => {
    const value = candidate(); mutate(value)
    expect(RepeatWorkflowVersionV1Schema.safeParse(value).success).toBe(false)
  })
  it.each([0, -1, 1.5, Infinity, NaN, undefined, 2147483648])('rejects missing/non-finite/invalid cap %s', (maxOccurrences) => {
    expect(RepeatBlockV1Schema.safeParse({ ...block(candidate()), maxOccurrences }).success).toBe(false)
  })
  it('does not invent a default or normalize an empty plan', () => {
    expect(RepeatPlanV1Schema.safeParse({ contractVersion: 1, blocks: [] }).success).toBe(false)
  })
})

describe('exact occurrence, accepted result, exit and successor provenance', () => {
  it.each([[1, 'issues', 'repeat'], [2, 'pass', 'early_exit'], [3, 'issues', 'limit_exit'], [3, 'pass', 'early_exit']] as const)(
    'validates occurrence %i / %s as %s', (index, outcome, reason) => {
      const f = evidence(index, outcome)
      expect(validateRepeatDecisionV1(f.version, f.decision, f.result)).toEqual(f.decision)
      expect(f.decision.reason).toBe(reason)
    })
  it('cap one routes remaining findings without creating a second occurrence', () => {
    const f = evidence(1, 'issues', 1)
    expect(validateRepeatDecisionV1(f.version, f.decision, f.result).target).toEqual({ kind: 'edge', relationshipId: 'review-limit' })
    expect(f.decision.resultData.remainingFindings).toHaveLength(1)
    expect(() => validateRepeatSuccessorV1(f.version, f.decision, occurrence(2), f.result)).toThrow()
  })
  it('keeps a technical retry in the same occurrence, input and business budget', () => {
    const f = evidence(); const before = structuredClone(f.decision.occurrence)
    f.decision.exitExecution.attempt = 3
    expect(validateRepeatDecisionV1(f.version, f.decision, f.result).occurrence).toEqual(before)
    expect(f.decision.target).toEqual({ kind: 'next_occurrence', entryNodeId: 'work', occurrenceIndex: 2 })
  })
  it('validates an adjacent carry with the exact prior result and decision', () => {
    const f = evidence(), next = occurrence(2)
    expect(validateRepeatSuccessorV1(f.version, f.decision, next, f.result)).toEqual(next)
  })
  it.each(['decisionId', 'acceptedResultDigest', 'occurrenceId'] as const)('rejects stale previous %s', (field) => {
    const f = evidence(), next = occurrence(2)
    next.input.previous![field] = field === 'acceptedResultDigest' ? digest(99) : 'stale'
    expect(() => validateRepeatSuccessorV1(f.version, f.decision, next, f.result)).toThrow()
  })
  it.each(['runId', 'workflowVersionId', 'workflowId', 'workspaceId'] as const)('rejects cross-scope successor %s', (field) => {
    const f = evidence(), next = occurrence(2); next.identity.scope[field] = 'other'
    expect(() => validateRepeatSuccessorV1(f.version, f.decision, next, f.result)).toThrow()
  })
  it('a full-Run retry starts a new Run/occurrence-one, never a carry from its parent Run', () => {
    const f = evidence(), nextRun = occurrence(1, 'run-retry')
    expect(RepeatOccurrenceV1Schema.parse(nextRun).input.previous).toBeNull()
    expect(() => validateRepeatSuccessorV1(f.version, f.decision, nextRun, f.result)).toThrow()
  })
  it.each([0, -1, 1.5])('rejects an invalid occurrence index %s', (index) => {
    const v = occurrence(); v.identity.occurrenceIndex = index
    expect(RepeatOccurrenceV1Schema.safeParse(v).success).toBe(false)
  })
  it('does not reinterpret attempts or retries as occurrence fields', () => {
    expect(RepeatOccurrenceV1Schema.safeParse({ ...occurrence(), attempt: 2 }).success).toBe(false)
    expect(RepeatOccurrenceV1Schema.safeParse({ ...occurrence(), retryOfRunId: 'old' }).success).toBe(false)
  })
  it('rejects missing ancestry, skipped occurrences and reuse of an input binding', () => {
    const f = evidence(), next = occurrence(2)
    expect(RepeatOccurrenceV1Schema.safeParse({ ...next, input: { ...next.input, previous: null } }).success).toBe(false)
    expect(() => validateRepeatSuccessorV1(f.version, f.decision, occurrence(3), f.result)).toThrow()
    next.input.bindingId = f.decision.occurrence.input.bindingId
    expect(() => validateRepeatSuccessorV1(f.version, f.decision, next, f.result)).toThrow()
  })
  it('rejects crossing an exit execution into another occurrence', () => {
    const f = evidence(); f.decision.exitExecution.occurrence.occurrenceId = 'other'
    expect(RepeatDecisionV1Schema.safeParse(f.decision).success).toBe(false)
  })
  it('rejects an extra occurrence, premature limit exit, wrong route and stale deliverable', () => {
    const excess = evidence(4)
    expect(() => validateRepeatDecisionV1(excess.version, excess.decision, excess.result)).toThrow()
    const early = evidence(); early.decision.reason = 'limit_exit'; early.decision.target = { kind: 'edge', relationshipId: 'review-limit' }
    expect(() => validateRepeatDecisionV1(early.version, early.decision, early.result)).toThrow()
    const wrong = evidence(3); wrong.decision.target = { kind: 'edge', relationshipId: 'review-done' }
    expect(() => validateRepeatDecisionV1(wrong.version, wrong.decision, wrong.result)).toThrow()
    const stale = evidence(3); stale.decision.resultData = { latestDeliverable: 'old', remainingFindings: [] }
    expect(() => validateRepeatDecisionV1(stale.version, stale.decision, stale.result)).toThrow()
  })
  it('rejects a wrong accepted outcome and exit configuration pin', () => {
    const f = evidence(); f.decision.outcome = 'pass'
    expect(() => validateRepeatDecisionV1(f.version, f.decision, f.result)).toThrow()
    const g = evidence(); g.decision.exitExecution.agentConfigurationVersionId = 'other'
    expect(() => validateRepeatDecisionV1(g.version, g.decision, g.result)).toThrow()
  })
  it('exposes content-free decision metadata without adding it to a feed', () => {
    const { resultData, ...metadata } = evidence().decision
    expect(resultData.latestDeliverable).toBeDefined()
    expect(RepeatDecisionMetadataV1Schema.parse(metadata)).toEqual(metadata)
    expect(RepeatDecisionMetadataV1Schema.safeParse({ ...metadata, resultData }).success).toBe(false)
  })
  it('accepts only a complete structured successful exit result', () => {
    const f = evidence(), choice = f.version.definition.nodes[1]!.choice!
    expect(parseRepeatExitResultV1({ ...f.result, output: JSON.stringify(f.result.output) }, choice).data).toEqual(f.decision.resultData)
    for (const output of ['Here is JSON: {}', '```json\n{}\n```', {}, { routing: { outcome: 'unknown' }, data: f.decision.resultData },
      { routing: { outcome: 'issues', target: 'work' }, data: f.decision.resultData }, { routing: { outcome: 'issues' }, data: {} }]) {
      expect(() => parseRepeatExitResultV1({ outcome: 'succeeded', output }, choice)).toThrow()
    }
    for (const result of [{ outcome: 'canceled' }, { outcome: 'failed', error: { code: 'FAIL', message: 'failed', retryable: true } }]) {
      expect(() => parseRepeatExitResultV1(result, choice)).toThrow()
    }
  })
  it('rejects missing, null, oversized and non-JSON carry data before recursive schema parsing', () => {
    const good = evidence().decision.resultData
    for (const data of [{ latestDeliverable: 'x' }, { ...good, latestDeliverable: null }, { ...good, extra: true },
      { ...good, latestDeliverable: 'x'.repeat(65537) }, { ...good, latestDeliverable: NaN }]) {
      expect(RepeatExitDataV1Schema.safeParse(data).success).toBe(false)
    }
    const cycle: Record<string, unknown> = {}; cycle.self = cycle
    expect(RepeatExitDataV1Schema.safeParse(cycle).success).toBe(false)
  })
})

describe('semantics-1/2 and current one-shot compatibility remain immutable', () => {
  it('round-trips the actual existing v2 fixture without repeat fields or mutation', () => {
    const f = makeWave25Fixture('compat'), before = JSON.stringify(f.version)
    expect(CompatibleWorkflowVersionSchema.parse(f.version)).toEqual(f.version)
    expect(ExecutableWorkflowV2Schema.safeParse({ version: f.version, configurations: f.configurations }).success).toBe(true)
    expect(JSON.stringify(f.version)).toBe(before)
    expect(RepeatWorkflowVersionV1Schema.safeParse(f.version).success).toBe(false)
  })
  it('round-trips a legacy untagged semantics-1 snapshot without retagging it', () => {
    const f = makeWave25Fixture('legacy'), { executionSemanticsVersion: tag, ...saved } = f.version
    const { executionSemanticsVersion: definitionTag, entryNodeId: authoredEntry, ...definition } = saved.definition
    expect([tag, definitionTag, authoredEntry]).toEqual([2, 2, saved.entryNodeId])
    const legacy = { ...saved, definition: { ...definition, edges: definition.edges.map(({ id, source, target }) => ({ id, source, target, route: { outcomes: ['succeeded'] } })) } }
    expect(WorkflowVersionSchema.parse(legacy)).toEqual(legacy)
    expect(CompatibleWorkflowVersionSchema.parse(legacy)).toEqual(legacy)
  })
  it('reserving semantics 3 enables neither saved read unions, admission, nor the graph protocol', () => {
    const v = candidate(), f = makeWave25Fixture('disabled')
    expect(ExecutionSemanticsVersionSchema.safeParse(3).success).toBe(false)
    expect(CompatibleWorkflowVersionSchema.safeParse(v).success).toBe(false)
    expect(ExecutableWorkflowV2Schema.safeParse({ version: v, configurations: f.configurations }).success).toBe(false)
    expect(RunGraphScopeSchema.safeParse(occurrence().identity.scope).success).toBe(false)
    expect(WorkflowVersionV2Schema.safeParse({ ...f.version, definition: { ...f.version.definition, repeat: v.definition.repeat } }).success).toBe(false)
  })
  it('leaves the original one-shot cycle rejection intact', () => {
    const f = makeWave25Fixture('cycle'), nodes = f.version.definition.nodes
    f.version.definition.edges.push(edge(nodes[1]!.id, nodes[0]!.id))
    expect(() => WorkflowVersionV2Schema.parse(f.version)).toThrow('acyclic')
  })
  it('does not impose repeat carry fields on ordinary named-choice results', () => {
    const choice = candidate().definition.nodes[1]!.choice!
    const result = { outcome: 'succeeded', output: { routing: { outcome: 'pass' }, data: { arbitraryExistingData: true } } }
    expect(parseChoiceResultEnvelope(result, choice).data).toEqual({ arbitraryExistingData: true })
    expect(() => parseRepeatExitResultV1(result, choice)).toThrow()
  })
})
