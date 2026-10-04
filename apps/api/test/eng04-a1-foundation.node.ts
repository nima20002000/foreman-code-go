import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HarnessExecution } from '@foreman-code/contracts'
import type { NodeResolution, RepeatWorkflowVersionV1 } from '@foreman-code/contracts/wave25'
import { compileExecutionTopology, decideExecutionAdmission, selectedTerminalResolutions } from '../src/modules/runs/topology.js'
import { runStartSemantics } from '../src/modules/runs/repeatStartDispatch.js'
import { ExecutionLimiter } from '../src/modules/runs/limiter.js'
import { RunnerAdmission } from '../src/modules/runs/runnerAdmission.js'
import {
  assertRepeatBodyComplete, assertRepeatRef, assertRepeatSource, bindRepeatNodeInput, compileRepeatLayout,
  decideRepeatAdmission, decideRepeatExit, finalRepeatExport, freezeRepeatEntry, makeRepeatOccurrence,
  repeatDigest, repeatExecutionIdentity, repeatSlotId, repeatSuccessorInput,
  type RepeatResolution, type RepeatNodeRef, type RepeatSource,
} from '../src/modules/runs/repeatResolution.js'

/** Node-only deterministic algorithm checks. These values are explicit TEST
 * input, not claimed schema-validated or persisted records. The separate Vitest
 * suites exercise the real schemas/graph. No runtime/schema stub is used here. */
const at = '2026-09-25T00:00:00.000Z'
function version(ids: string[], pairs: Array<[string, string]>): RepeatWorkflowVersionV1 {
  return { id: 'wv-a1-node', workspaceId: 'ws-a1-node', workflowId: 'wf-a1-node', version: 1,
    executionSemanticsVersion: 3, entryNodeId: ids[0]!, approval: { handler: 'user' },
    agentConfigurationVersionIds: Object.fromEntries(ids.map((id) => [`agent-${id}`, `config-${id}`])),
    contentHash: `sha256:${'0'.repeat(64)}`, createdAt: at,
    definition: { id: 'wf-a1-node', workspaceId: 'ws-a1-node', version: 1, name: 'A1 node-test input',
      executionSemanticsVersion: 3, entryNodeId: ids[0]!, executionCondition: { kind: 'manual' }, approval: { handler: 'user' },
      executionPolicy: { maxParallelism: 3, maxNodeExecutions: ids.length },
      nodes: ids.map((id) => ({ id, agentId: `agent-${id}`, name: id })),
      edges: pairs.map(([source, target]) => ({ id: `${source}-${target}`, source, target, kind: 'execution' })) } }
}
function completed(v: RepeatWorkflowVersionV1, nodeId: string, id = `execution-${nodeId}`, attempt = 1): HarnessExecution {
  return { id, runId: 'run-a1-node', workflowNodeId: nodeId, agentId: `agent-${nodeId}`,
    agentConfigurationVersionId: v.agentConfigurationVersionIds[`agent-${nodeId}`]!, attempt,
    input: {}, state: 'completed', result: { outcome: 'succeeded', output: { nodeId } }, createdAt: at, finishedAt: at }
}
function resolution(v: RepeatWorkflowVersionV1, id: string, yes?: string[]): NodeResolution {
  const execution = completed(v, id), outgoing = v.definition.edges.filter((edge) => edge.kind === 'execution' && edge.source === id).map((edge) => edge.id)
  const selected = yes ?? outgoing
  return { workflowNodeId: id, execution: repeatExecutionIdentity(execution), resolution: 'succeeded',
    acceptedResultDigest: repeatDigest(execution.result), branchEnded: selected.length === 0,
    selectedRelationshipIds: selected, unselectedRelationshipIds: outgoing.filter((edge) => !selected.includes(edge)), resolvedAt: at }
}
function repeated(cap = 3) {
  const v = version(['a', 'b'], [['a', 'b']])
  v.definition.nodes[1]!.choice = { outcomes: [{ outcome: 'pass', target: { kind: 'branch_end' } }, { outcome: 'issues', target: { kind: 'branch_end' } }] }
  v.definition.repeat = { contractVersion: 1, blocks: [{ id: 'repair', nodeIds: ['a', 'b'], entryNodeId: 'a', exitNodeId: 'b',
    maxOccurrences: cap, earlyExitOutcome: 'pass', repeatOutcome: 'issues', limitExit: { kind: 'branch_end' } }] }
  v.definition.executionPolicy!.maxNodeExecutions = cap * 2
  const scope = { workspaceId: v.workspaceId, workflowId: v.workflowId, workflowVersionId: v.id, runId: 'run-a1-node', executionSemanticsVersion: 3 as const }
  const entry = freezeRepeatEntry({ request: 'test' }, []), block = v.definition.repeat.blocks[0]!
  const first = makeRepeatOccurrence(scope, block, entry, null)
  return { v, scope, block, entry, first }
}

void test('A1 offline S3-01: single and sequential ordinary graphs have no boundaries or repeat records', () => {
  for (const v of [version(['a'], []), version(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']])]) {
    const layout = compileRepeatLayout(v), topology = compileExecutionTopology(v), rows = new Map<string, NodeResolution>()
    assert.equal(layout.boundaries.length, 0); assert.equal(layout.nodes.length, v.definition.nodes.length)
    assert(layout.nodes.every((node) => node.kind === 'once')); assert.equal(Object.hasOwn(v.definition, 'repeat'), false)
    for (const id of topology.order) { assert.equal(decideExecutionAdmission(topology, id, rows).kind, 'run'); rows.set(id, resolution(v, id)) }
    assert.deepEqual(selectedTerminalResolutions([...rows.values()]).map((row) => row.workflowNodeId), [topology.order.at(-1)])
  }
})
void test('A1 offline S3-02: all-required unequal join cannot confuse missing with unselected', () => {
  const v = version(['a', 'b', 'c', 'long', 'join'], [['a', 'b'], ['a', 'c'], ['b', 'join'], ['c', 'long'], ['long', 'join']])
  const graph = compileExecutionTopology(v), rows = new Map([['a', resolution(v, 'a')], ['b', resolution(v, 'b')], ['c', resolution(v, 'c')]])
  assert.equal(decideExecutionAdmission(graph, 'join', rows).kind, 'waiting')
  assert.equal(decideExecutionAdmission(graph, 'long', rows).kind, 'run')
  rows.set('long', resolution(v, 'long'))
  const decision = decideExecutionAdmission(graph, 'join', rows)
  assert.equal(decision.kind, 'run')
  if (decision.kind === 'run') assert.deepEqual(decision.selected.map((edge) => edge.id), ['b-join', 'long-join'])
})
void test('A1 offline S3-03: selected and unselected branches join only after both decisions settle', () => {
  const v = version(['a', 'b', 'c', 'join'], [['a', 'b'], ['a', 'c'], ['b', 'join'], ['c', 'join']])
  const graph = compileExecutionTopology(v), rows = new Map([['a', resolution(v, 'a', ['a-b'])]])
  assert.equal(decideExecutionAdmission(graph, 'b', rows).kind, 'run')
  assert.equal(decideExecutionAdmission(graph, 'c', rows).kind, 'skipped')
  rows.set('b', resolution(v, 'b'))
  assert.equal(decideExecutionAdmission(graph, 'join', rows).kind, 'waiting')
  rows.set('c', { workflowNodeId: 'c', resolution: 'skipped', branchEnded: false,
    selectedRelationshipIds: [], unselectedRelationshipIds: ['c-join'], resolvedAt: at })
  const result = decideExecutionAdmission(graph, 'join', rows)
  assert.equal(result.kind, 'run'); if (result.kind === 'run') assert.deepEqual(result.selected.map((edge) => edge.id), ['b-join'])
})
void test('A1 offline S3-03: branch-end counts as terminal without launching downstream work', () => {
  const v = version(['a', 'b'], [['a', 'b']]), row = resolution(v, 'a', [])
  assert.deepEqual(selectedTerminalResolutions([row]), [row])
  assert.equal(decideExecutionAdmission(compileExecutionTopology(v), 'b', new Map([['a', row]])).kind, 'skipped')
})
void test('A1 offline S3-04: approval relationships do not change execution dependencies or serialize siblings', () => {
  const v = version(['reviewer', 'left', 'right'], [['reviewer', 'left'], ['reviewer', 'right']])
  v.definition.edges.push({ id: 'approval-left', kind: 'approval', source: 'reviewer', target: 'left' })
  const graph = compileExecutionTopology(v), rows = new Map([['reviewer', resolution(v, 'reviewer')]])
  assert.equal(graph.incoming.get('left')!.length, 1)
  assert.equal(decideExecutionAdmission(graph, 'left', rows).kind, 'run')
  assert.equal(decideExecutionAdmission(graph, 'right', rows).kind, 'run')
})
void test('A1 offline rejects a replay/predecessor resolution filed under another node', () => {
  const v = version(['a', 'b'], [['a', 'b']]), graph = compileExecutionTopology(v)
  assert.throws(() => decideExecutionAdmission(graph, 'b', new Map([['b', resolution(v, 'a')]])), { code: 'WORKFLOW_RESOLUTION_INVALID' })
  assert.throws(() => decideExecutionAdmission(graph, 'b', new Map([['a', resolution(v, 'b')]])), { code: 'WORKFLOW_RESOLUTION_INVALID' })
})
void test('A1 offline rejects selected predecessors without exact accepted result identity/digest', () => {
  const v = version(['a', 'b'], [['a', 'b']]), graph = compileExecutionTopology(v), row = resolution(v, 'a')
  delete row.acceptedResultDigest
  assert.throws(() => decideExecutionAdmission(graph, 'b', new Map([['a', row]])), { code: 'WORKFLOW_RESOLUTION_INVALID' })
})
void test('A1 offline rejects arbitrary cycles, duplicate IDs and excluded dependencies', () => {
  assert.throws(() => compileExecutionTopology(version(['a', 'b'], [['a', 'b'], ['b', 'a']])), { code: 'WORKFLOW_ENTRY_DEPENDENCY' })
  assert.throws(() => compileExecutionTopology(version(['a', 'b', 'b'], [])), { code: 'WORKFLOW_ENTRY_INVALID' })
  assert.throws(() => compileExecutionTopology(version(['a', 'b', 'excluded'], [['a', 'b'], ['excluded', 'b']])), { code: 'WORKFLOW_EXCLUDED_DEPENDENCY' })
})
for (const tag of [undefined, null, 0, 1, 2, 4, '3', true]) void test(`A1 offline retired/missing/unknown saved tag ${String(tag)} is denied`, () => {
  assert.throws(() => runStartSemantics({ executionSemanticsVersion: tag }), { code: 'EXECUTION_SEMANTICS_UNSUPPORTED' })
})
void test('A1 offline exact saved semantics 3 is the sole accepted dispatch tag', () => assert.equal(runStartSemantics({ executionSemanticsVersion: 3 }), 3))
for (const mode of ['early', 'limit'] as const) void test(`A1 offline S3-05 ${mode} progression has bounded exact result/ancestry identity`, () => {
  const f = repeated(), ids = new Set<string>(), expected = mode === 'early' ? 2 : 3
  let current = f.first
  for (let index = 1; index <= expected; index++) {
    const identity = current.occurrence.identity
    assert.equal(identity.occurrenceIndex, index); assert(!ids.has(identity.occurrenceId)); ids.add(identity.occurrenceId)
    const execution = completed(f.v, 'b', `exit-${index}`), outcome = mode === 'early' && index === expected ? 'pass' : 'issues'
    const envelope = { routing: { outcome }, data: { latestDeliverable: { revision: index }, remainingFindings: outcome === 'pass' ? [] : ['finding'] } }
    execution.result = { outcome: 'succeeded', output: envelope }
    const decision = decideRepeatExit(f.v, current.occurrence, execution, envelope, at)
    assert.equal(decision.acceptedResultDigest, repeatDigest(execution.result))
    if (index < expected) {
      assert.equal(decision.reason, 'repeat')
      const input = repeatSuccessorInput(current.input, decision, execution.result)
      const next = makeRepeatOccurrence(f.scope, f.block, input, decision)
      assert.equal(next.occurrence.input.previous!.decisionId, decision.decisionId)
      assert.equal(next.input.carry!.execution.executionId, execution.id)
      assert.equal(next.input.carry!.acceptedResultDigest, repeatDigest(execution.result))
      assert.notEqual(next.occurrence.input.bindingId, current.occurrence.input.bindingId)
      current = next
    } else {
      assert.equal(decision.reason, mode === 'early' ? 'early_exit' : 'limit_exit')
      assert.deepEqual(decision.resultData.remainingFindings, mode === 'early' ? [] : ['finding'])
      assert.throws(() => makeRepeatOccurrence(f.scope, f.block, repeatSuccessorInput(current.input, decision, execution.result!), decision))
    }
  }
  assert.equal(ids.size, expected)
})
void test('A1 offline business occurrence IDs are deterministic but isolated by full Run retry identity', () => {
  const f = repeated(), replay = makeRepeatOccurrence(f.scope, f.block, f.entry, null)
  assert.deepEqual(replay, f.first)
  const another = makeRepeatOccurrence({ ...f.scope, runId: 'new-full-run' }, f.block, f.entry, null)
  assert.notEqual(another.occurrence.identity.occurrenceId, f.first.occurrence.identity.occurrenceId)
})
void test('A1 offline technical attempt changes execution/binding ID but retains occurrence, frozen input and logical slot', () => {
  const f = repeated(), ref = { nodeId: 'a', occurrence: f.first.occurrence.identity }
  const one = completed(f.v, 'a', 'attempt-one', 1), two = completed(f.v, 'a', 'attempt-two', 2)
  const bind = (recipient: HarnessExecution) => bindRepeatNodeInput({ version: f.v, ref, recipient,
    runInput: f.entry.runInput, occurrence: f.first.occurrence, entry: f.entry, predecessors: [] })
  assert.equal(bind(one).digest, bind(two).digest)
  assert.equal(repeatSlotId(f.scope.runId, ref), repeatSlotId(f.scope.runId, structuredClone(ref)))
  assert.deepEqual(bind(two).input.occurrence, f.first.occurrence)
})
void test('A1 offline ordinary input binding keeps exact predecessor/result/attempt but creates no carry/occurrence input', () => {
  const v = version(['a', 'b'], [['a', 'b']]), sourceExecution = completed(v, 'a'), recipient = completed(v, 'b')
  const source: RepeatSource = { relationshipId: 'a-b', execution: repeatExecutionIdentity(sourceExecution), occurrence: null,
    acceptedResult: sourceExecution.result!, acceptedResultDigest: repeatDigest(sourceExecution.result) }
  const bound = bindRepeatNodeInput({ version: v, runInput: { request: 'ordinary' }, recipient, ref: { nodeId: 'b', occurrence: null },
    occurrence: null, entry: null, predecessors: [source] })
  assert.equal(bound.input.occurrence, null); assert.equal(bound.input.entry, null)
  assert.deepEqual(bound.bindings.map((binding) => binding.kind), ['predecessor'])
  assert.equal(bound.bindings[0]!.recipient.executionId, recipient.id)
  assert.equal(bound.bindings[0]!.source.acceptedResultDigest, repeatDigest(sourceExecution.result))
  const scope = { workspaceId: v.workspaceId, workflowId: v.workflowId, workflowVersionId: v.id, runId: recipient.runId, executionSemanticsVersion: 3 as const }
  assertRepeatSource(v, scope, source, sourceExecution, true)
  assert.throws(() => assertRepeatSource(v, scope, { ...source, acceptedResultDigest: `sha256:${'f'.repeat(64)}` }, sourceExecution, true), { code: 'REPEAT_INPUT_NOT_ACCEPTED' })
})
void test('A1 offline cross-occurrence joins, missing body results, and synthetic ordinary occurrences are denied', () => {
  const f = repeated(), one = f.first.occurrence.identity, two = { ...one, occurrenceId: 'different-occurrence', occurrenceIndex: 2 }
  const row: RepeatResolution = { ref: { nodeId: 'a', occurrence: one }, value: resolution(f.v, 'a'), deferredRelationshipIds: [] }
  assert.throws(() => decideRepeatAdmission(f.v, { nodeId: 'b', occurrence: two }, new Map([['a', row]])), { code: 'REPEAT_CROSS_OCCURRENCE_JOIN' })
  assert.throws(() => assertRepeatBodyComplete(f.v, one, new Map([['a', row]])), { code: 'REPEAT_BODY_UNRESOLVED' })
  const ordinary = version(['a'], [])
  assert.throws(() => assertRepeatRef(ordinary, f.scope, { nodeId: 'a', occurrence: one }), { code: 'REPEAT_OCCURRENCE_CONFLICT' })
  assert.throws(() => decideRepeatAdmission(f.v, { nodeId: 'a', occurrence: null }, new Map()), { code: 'REPEAT_OCCURRENCE_CONFLICT' })
})
void test('A1 offline repeat joins do not accept prior-result bytes from another business occurrence', () => {
  const f = repeated(), first = f.first.occurrence.identity, other = { ...first, occurrenceId: 'other', occurrenceIndex: 2 }
  const source = completed(f.v, 'a'), recipient = completed(f.v, 'b')
  const predecessors: RepeatSource[] = [{ relationshipId: 'a-b', execution: repeatExecutionIdentity(source), occurrence: other,
    acceptedResult: source.result!, acceptedResultDigest: repeatDigest(source.result) }]
  assert.throws(() => bindRepeatNodeInput({ version: f.v, runInput: f.entry.runInput, recipient,
    ref: { nodeId: 'b', occurrence: first }, occurrence: f.first.occurrence, entry: f.entry, predecessors }), { code: 'REPEAT_CROSS_OCCURRENCE_JOIN' })
})
void test('A1 offline intermediate repeat exits cannot export external routing', () => {
  const f = repeated(), execution = completed(f.v, 'b'), envelope = { routing: { outcome: 'issues' }, data: { latestDeliverable: 'v1', remainingFindings: ['pending'] } }
  execution.result = { outcome: 'succeeded', output: envelope }
  const decision = decideRepeatExit(f.v, f.first.occurrence, execution, envelope, at)
  const local: RepeatResolution = { ref: { nodeId: 'b', occurrence: f.first.occurrence.identity },
    value: { ...resolution(f.v, 'b'), acceptedResultDigest: decision.acceptedResultDigest }, deferredRelationshipIds: [] }
  assert.throws(() => finalRepeatExport(f.v, local, decision), { code: 'REPEAT_EGRESS_UNRESOLVED' })
})
void test('A1 offline cap does not unroll graph nodes; removing repeat removes all boundary wrappers', () => {
  const f = repeated(3), before = compileRepeatLayout(f.v)
  f.block.maxOccurrences = 20
  const after = compileRepeatLayout(f.v)
  assert.deepEqual(after.nodes, before.nodes); assert.deepEqual(after.edges, before.edges)
  assert(after.recursionLimit > before.recursionLimit)
  delete f.v.definition.repeat
  assert.deepEqual(compileRepeatLayout(f.v).boundaries, [])
})
void test('A1 offline frozen entry is an immutable copy; wrong carry result or ancestry is rejected', () => {
  const f = repeated(), original = { request: 'mutable' }, entry = freezeRepeatEntry(original, [])
  original.request = 'changed'; assert.equal(entry.runInput.request, 'mutable')
  const execution = completed(f.v, 'b'), envelope = { routing: { outcome: 'issues' }, data: { latestDeliverable: 'ok', remainingFindings: [] } }
  execution.result = { outcome: 'succeeded', output: envelope }
  const decision = decideRepeatExit(f.v, f.first.occurrence, execution, envelope, at)
  assert.throws(() => repeatSuccessorInput(f.entry, decision, { outcome: 'succeeded', output: 'wrong' }), { code: 'REPEAT_CARRY_CONFLICT' })
  const nextInput = repeatSuccessorInput(f.entry, decision, execution.result)
  assert.throws(() => makeRepeatOccurrence({ ...f.scope, runId: 'wrong-run' }, f.block, nextInput, decision), { code: 'REPEAT_ANCESTRY_CONFLICT' })
})
void test('A1 offline ordinary admission replay preserves exact resolution without new execution work', () => {
  const v = version(['a', 'b'], [['a', 'b']]), row = resolution(v, 'b'), ref: RepeatNodeRef = { nodeId: 'b', occurrence: null }
  const result = decideRepeatAdmission(v, ref, new Map([['b', { ref, value: row, deferredRelationshipIds: [] }]]))
  assert.equal(result.kind, 'resolved'); if (result.kind === 'resolved') assert.equal(result.resolution, row)
})
void test('A1 offline Stop aborts queued per-Run and shared admission before the waiting callback can launch', async () => {
  for (const limiter of [new ExecutionLimiter(1), new RunnerAdmission(1)]) {
    const controller = new AbortController(); let release!: () => void, reached!: () => void
    const gate = new Promise<void>((done) => { release = done }), entered = new Promise<void>((done) => { reached = done })
    const run = (work: () => Promise<void>) => limiter instanceof RunnerAdmission ? limiter.run('run-a1-stop', controller.signal, work) : limiter.run(controller.signal, work)
    const one = run(async () => { reached(); await gate }); await entered
    let launches = 0; const waiting = run(async () => { launches++ })
    controller.abort(new Error('committed Stop'))
    await assert.rejects(waiting, /committed Stop/); release(); await one; assert.equal(launches, 0)
  }
})
