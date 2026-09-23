/* global structuredClone */
/** Run from a full exact-base checkout after applying this lane:
 * node --experimental-vm-modules --test apps/api/test/wave25-br2-002-cancellation.smoke.mjs
 * These source/port checks are deliberately separate from PostgreSQL integration.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ports, interaction, requester, scope } from './helpers/wave25Br2002Ports.mjs'

const retirements = (f) => f.data.batches.flatMap((b) => b.events).filter((e) => e.fact.type === 'exchange.retired' && e.fact.exchangeKind === 'interaction')
function assertFinalStateAndRetirement(f, id) {
  const batches = f.data.batches.filter((b) => b.events.some((e) => e.fact.type === 'exchange.retired' && e.fact.exchangeId === id))
  assert.equal(batches.length, 1)
  const events = batches[0].events, index = events.findIndex((e) => e.fact.type === 'exchange.retired' && e.fact.exchangeId === id)
  const retired = events[index], final = events[index - 1]
  assert.equal(final.fact.type, 'interaction.state')
  assert.equal(final.fact.interaction.interactionId, id)
  assert.equal(final.fact.interaction.status, 'canceled')
  assert.equal(final.fact.interaction.revision, retired.fact.finalRevision)
  assert.deepEqual(final.evidence, retired.evidence)
  assert.equal(final.fact.interaction.resumeAcknowledgementId, undefined)
}

test('direct cancellation publishes final state and retirement with complete reference parity', async () => {
  const f = await ports(), initial = await f.snapshot()
  await f.repository.cancelPendingForExecution(requester.id, ['native-interaction-one'])
  const current = await f.replay(initial)
  assert.deepEqual(current.state.interactions, [])
  assert.equal(current.state.run.pendingInteractionCount, 0)
  assert.equal(f.data.records.get('interaction-one').revision, 2)
  assertFinalStateAndRetirement(f, 'interaction-one')
  const sequence = f.data.sequence, record = structuredClone(f.data.records.get('interaction-one'))
  await f.repository.cancelPendingForExecution(requester.id, ['native-interaction-one'])
  assert.equal(f.data.sequence, sequence)
  assert.deepEqual(f.data.records.get('interaction-one'), record)
  await f.replay(current)
})

test('wrong/empty native request IDs cannot cancel an unrelated interaction', async () => {
  const f = await ports(), initial = await f.snapshot()
  await f.repository.cancelPendingForExecution(requester.id, ['wrong-native-request'])
  await f.repository.cancelPendingForExecution(requester.id, [])
  assert.equal(f.data.sequence, 0)
  assert.deepEqual(await f.snapshot(), initial)
})

test('omitted request IDs still require terminal execution evidence', async () => {
  const f = await ports(), initial = await f.snapshot()
  await assert.rejects(f.repository.cancelPendingForExecution(requester.id), { code: 'APPROVAL_TERMINAL_EVIDENCE_REQUIRED' })
  assert.deepEqual(await f.snapshot(), initial)
  f.data.executionCompleted = true
  await f.repository.cancelPendingForExecution(requester.id)
  await f.replay(initial)
  assertFinalStateAndRetirement(f, 'interaction-one')
})

for (const stopped of [false, true]) test(`${stopped ? 'Stop' : 'non-Stop'} cleanup retains until the confirmed cleanup hook and repeats without mutations`, async () => {
  const f = await ports(); f.data.cleanupAllowed = true; f.data.stopped = stopped
  const initial = await f.snapshot()
  assert.equal(await f.repository.cancelPendingForRun(scope.runId), 1)
  let current = await f.replay(initial)
  assert.equal(current.state.interactions.length, 1)
  assert.equal(current.state.interactions[0].resumeState, 'unknown')
  assert.equal(retirements(f).length, 0)
  const sequence = f.data.sequence, finalRevision = f.data.records.get('interaction-one').revision
  assert.equal(await f.repository.cancelPendingForRun(scope.runId), 0)
  assert.equal(f.data.sequence, sequence)
  assert.equal(f.data.deliveryFences.get('interaction-one'), 1)
  await assert.rejects(f.repository.coordination.finishStoppedReviews(scope.runId, true), { code: 'UNCONFIRMED_NATIVE_CLOSURE' })
  assert.equal(retirements(f).length, 0)
  f.data.nativeClosed = true
  await assert.rejects(f.repository.coordination.finishStoppedReviews(scope.runId, true), { code: 'REVIEW_CREDENTIAL_CLEANUP_PENDING' })
  assert.equal(retirements(f).length, 0)
  f.data.credentialsRevoked = true
  await f.repository.coordination.finishStoppedReviews(scope.runId, true)
  current = await f.replay(current)
  assert.deepEqual(current.state.interactions, [])
  assertFinalStateAndRetirement(f, 'interaction-one')
  assert.equal(f.data.records.get('interaction-one').revision, finalRevision)
  assert.equal(current.state.run.stopRequested, stopped)
  const retiredSequence = f.data.sequence
  await f.repository.coordination.finishStoppedReviews(scope.runId, true)
  assert.equal(f.data.sequence, retiredSequence)
  await f.replay(current)
})

for (const state of ['submitted', 'uncertain', 'failed', 'delivered']) test(`attempted ${state} delivery stays uncertain/retained until confirmed closure; evidence is not rewritten`, async () => {
  const r = { ...interaction(), status: 'delivery_pending', deliveryState: 'uncertain', selectedOptionId: 'approve-once', selectedSemantic: 'approve_once' }
  const f = await ports({ records: [r] }); f.data.cleanupAllowed = true
  f.data.attempts.set(r.id, { state, correlationId: 'exact-native-response', nativeRequestId: r.nativeRequestId, leaseExpiresAt: '2099-01-01' })
  f.data.resumes.set(r.id, { state: 'pending', revision: 1, ack: null, owner: 'old-owner' })
  const initial = await f.snapshot()
  await f.repository.cancelPendingForRun(scope.runId)
  const canceled = await f.replay(initial), attempt = structuredClone(f.data.attempts.get(r.id)), resume = structuredClone(f.data.resumes.get(r.id))
  assert.equal(canceled.state.interactions[0].status, 'canceled')
  assert.equal(canceled.state.interactions[0].resumeState, 'unknown')
  assert.equal(attempt.state, state === 'submitted' ? 'uncertain' : state)
  assert.equal(attempt.correlationId, 'exact-native-response')
  assert.equal(resume.ack, null)
  await f.repository.cancelPendingForRun(scope.runId)
  assert.deepEqual(f.data.attempts.get(r.id), attempt)
  assert.deepEqual(f.data.resumes.get(r.id), resume)
  f.data.nativeClosed = true; f.data.credentialsRevoked = true
  await f.repository.coordination.finishStoppedReviews(scope.runId, true)
  await f.replay(canceled)
  assert.deepEqual(f.data.attempts.get(r.id), attempt)
  assert.deepEqual(f.data.resumes.get(r.id), resume)
  assertFinalStateAndRetirement(f, r.id)
})

for (const obligation of ['attempt', 'resume', 'review']) test(`direct cancellation retains the ${obligation} obligation on both surfaces`, async () => {
  const r = interaction(); if (obligation === 'review') r.approval = { handler: 'orchestrator' }
  const f = await ports({ records: [r] })
  if (obligation === 'attempt') f.data.attempts.set(r.id, { state: 'uncertain' })
  if (obligation === 'resume') f.data.resumes.set(r.id, { state: 'pending', ack: null })
  if (obligation === 'review') f.data.jobs.set('job-one', { id: 'job-one', interactionId: r.id, state: 'submitted', revision: 2, attempt: 1, submittedAt: '2026-09-22T00:00:00.000Z' })
  const initial = await f.snapshot()
  await f.repository.cancelPendingForExecution(requester.id, [r.nativeRequestId])
  const canceled = await f.replay(initial)
  assert.equal(canceled.state.interactions.length, 1)
  assert.equal(canceled.state.interactions[0].resumeState, 'unknown')
  assert.equal(retirements(f).length, 0)
  const sequence = f.data.sequence
  await f.repository.cancelPendingForExecution(requester.id, [r.nativeRequestId])
  assert.equal(f.data.sequence, sequence)
})

test('confirmed review cleanup and interaction retirement share a batch and replay every field', async () => {
  const r = { ...interaction(), approval: { handler: 'orchestrator' } }, f = await ports({ records: [r] })
  f.data.jobs.set('job-one', { id: 'job-one', interactionId: r.id, state: 'submitted', revision: 2, attempt: 1, submittedAt: '2026-09-22T00:00:00.000Z' })
  f.data.cleanupAllowed = true
  const initial = await f.snapshot()
  await f.repository.cancelPendingForRun(scope.runId)
  const canceled = await f.replay(initial)
  assert.equal(canceled.state.reviews.length, 1)
  f.data.nativeClosed = true; f.data.credentialsRevoked = true
  await f.repository.coordination.finishStoppedReviews(scope.runId, true)
  const clean = await f.replay(canceled)
  assert.deepEqual(clean.state.interactions, [])
  assert.deepEqual(clean.state.reviews, [])
  assert.equal(clean.state.run.unsettledReviewCount, 0)
  assertFinalStateAndRetirement(f, r.id)
  const batch = f.data.batches.at(-1)
  assert.ok(batch.events.some((e) => e.fact.type === 'exchange.retired' && e.fact.exchangeKind === 'review'))
  assert.ok(batch.events.some((e) => e.fact.type === 'exchange.retired' && e.fact.exchangeKind === 'interaction'))
})

test('later eligibility does not hide a canceled row until an explicit retirement publication', async () => {
  const f = await ports(); f.data.attempts.set('interaction-one', { state: 'uncertain' })
  const initial = await f.snapshot()
  await f.repository.cancelPendingForExecution(requester.id, ['native-interaction-one'])
  const retained = await f.replay(initial)
  // Represents a different producer settling an obligation, not a native proof.
  // The reader must not silently remove the row just because eligibility changed.
  f.data.attempts.clear()
  assert.deepEqual((await f.snapshot()).state.interactions, retained.state.interactions)
  await f.repository.cancelPendingForExecution(requester.id, ['native-interaction-one'])
  const retired = await f.replay(retained)
  assert.deepEqual(retired.state.interactions, [])
  assert.equal(f.data.records.get('interaction-one').revision, 2)
})

test('a mismatched/stale retirement receipt cannot hide a later canceled revision', async () => {
  const f = await ports(); f.data.attempts.set('interaction-one', { state: 'uncertain' })
  await f.repository.cancelPendingForExecution(requester.id, ['native-interaction-one'])
  const id = f.publication.canceledRetirementSourceId('interaction-one')
  f.data.receipts.set(`cleanup/${id}/1`, { sourceDigest: 'wrong', semanticDigest: 'wrong' })
  assert.equal((await f.snapshot()).state.interactions.length, 1)
  f.data.receipts.set(`cleanup/${id}/2`, { sourceDigest: 'wrong', semanticDigest: 'wrong' })
  assert.equal((await f.snapshot()).state.interactions.length, 1)
})

test('failure before commit rolls back canceled state and retirement together', async () => {
  const f = await ports(), initial = await f.snapshot(), receipts = structuredClone(f.data.receipts)
  f.data.failBeforeCommit = true
  await assert.rejects(f.repository.cancelPendingForExecution(requester.id, ['native-interaction-one']), /injected-before-commit/)
  assert.deepEqual(await f.snapshot(), initial)
  assert.deepEqual(f.data.receipts, receipts)
  assert.equal(f.data.batches.length, 0)
  f.data.failBeforeCommit = false
  await f.repository.cancelPendingForExecution(requester.id, ['native-interaction-one'])
  await f.replay(initial)
})

test('Run cancellation still requires durable negative authority', async () => {
  const f = await ports(), initial = await f.snapshot()
  await assert.rejects(f.repository.cancelPendingForRun(scope.runId), { code: 'EXECUTION_NOT_STOPPED' })
  assert.deepEqual(await f.snapshot(), initial)
})

test('legacy cancellation delegates unchanged without a v2 publication', async () => {
  const f = await ports(); f.data.v2 = false
  await f.repository.cancelPendingForExecution(requester.id, ['native-one'])
  assert.equal(await f.repository.cancelPendingForRun(scope.runId), 7)
  assert.deepEqual(f.data.legacyCalls, [['execution', requester.id, ['native-one']], ['run', scope.runId]])
  assert.equal(f.data.batches.length, 0)
})

test('multiple exact request cancellations retire once in one complete publication', async () => {
  const f = await ports({ records: [interaction('one'), interaction('two'), interaction('three')] }), initial = await f.snapshot()
  await f.repository.cancelPendingForExecution(requester.id, ['native-one', 'native-three'])
  const current = await f.replay(initial)
  assert.deepEqual(current.state.interactions.map((r) => r.interactionId), ['two'])
  assert.equal(f.data.batches.length, 1)
  assert.equal(retirements(f).length, 2)
})

test('unresolved canceled exchanges remain bounded, not silently dropped to fit', async () => {
  const records = Array.from({ length: 2001 }, (_, i) => ({ ...interaction(`id-${String(i).padStart(4,'0')}`), status: 'canceled' }))
  const f = await ports({ records })
  await assert.rejects(f.snapshot(), { code: 'GRAPH_SNAPSHOT_TOO_LARGE' })
})

test('retirement source IDs are bounded and distinct for maximum-length IDs', async () => {
  const f = await ports(), a = f.publication.canceledRetirementSourceId('a'.repeat(200)), b = f.publication.canceledRetirementSourceId('a'.repeat(199) + 'b')
  assert.match(a, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/)
  assert.notEqual(a,b)
})

for (const cleanup of [undefined, { completedAt: '2026-09-22T01:00:00.000Z', nativeState: 'pending', credentialState: 'revoked' },
  { completedAt: '2026-09-22T01:00:00.000Z', nativeState: 'closed', credentialState: 'pending' }]) {
  test(`a failed review with ${cleanup ? 'pending ' + (cleanup.nativeState === 'pending' ? 'native' : 'credential') : 'unconfirmed'} cleanup is not retirement evidence`, async () => {
    const r = { ...interaction(), approval: { handler: 'orchestrator' } }, f = await ports({ records: [r] })
    f.data.jobs.set('job-pending-cleanup', { id: 'job-pending-cleanup', interactionId: r.id, state: 'failed', revision: 2, attempt: 1, cleanup })
    await f.repository.cancelPendingForExecution(requester.id, [r.nativeRequestId])
    assert.equal((await f.snapshot()).state.interactions.length, 1)
    assert.equal(retirements(f).length, 0)
  })
}

test('retirement survives journal pruning because snapshots use durable source receipts', async () => {
  const f = await ports()
  await f.repository.cancelPendingForExecution(requester.id, ['native-interaction-one'])
  f.data.batches = []
  assert.deepEqual((await f.snapshot()).state.interactions, [])
  assert.ok(f.retired(f.data.records.get('interaction-one')))
})

test('repeated cleanup in the same publication stages only one final-state retirement source', async () => {
  const f = await ports(); f.data.cleanupAllowed = true
  await f.repository.cancelPendingForRun(scope.runId)
  const canceled = await f.snapshot()
  f.data.nativeClosed = true; f.data.credentialsRevoked = true
  await f.transact(async (publication) => {
    await f.repository.coordination.finishStoppedReviewsInPublication(publication, true)
    await f.repository.coordination.finishStoppedReviewsInPublication(publication, true)
  })
  await f.replay(canceled)
  assertFinalStateAndRetirement(f, 'interaction-one')
  assert.equal(retirements(f).length, 1)
})

/** Correction coverage: these cases do not stub approvalAttentionFacts,
 * readPublicNodeProjection, the attention overlay or the activity selector.
 * SQL/authority/schema/transaction/native-row ports remain simulated. */
function request(id = 'request-one') {
  return { ...interaction(id), revision: 0, workspaceId: scope.workspaceId, workflowId: scope.workflowId,
    requestingAgentId: requester.agentId, harness: 'codex', providerVersion: 'source-port-only',
    nativeSessionId: 'session-worker', nativeRequestType: 'item/commandExecution/requestApproval',
    graphThreadId: scope.runId, request: {}, responseOptions: [] }
}
function withWorkflowCandidate(f) {
  // A source-selection fixture, NOT a native-ingestion or acknowledgement claim.
  const execution = { workflowNodeId: requester.workflowNodeId, executionId: requester.id,
    agentId: requester.agentId, agentConfigurationVersionId: requester.agentConfigurationVersionId, attempt: 1 }
  f.data.native.push({ key: { execution, workKind: 'workflow', workId: requester.id },
    activity: { workflowNodeId: requester.workflowNodeId, status: 'unknown' }, lastNativeSequence: '1' })
}
const workerNode = (snapshot) => snapshot.state.nodes.find((node) => node.state.workflowNodeId === requester.workflowNodeId)

for (const native of [false, true]) test(`real projection: create/cancel/repeat with ${native ? 'a workflow candidate' : 'no native row'} has complete parity`, async () => {
  const f = await ports({ actualProjection: true, records: [] }), r = request()
  if (native) withWorkflowCandidate(f)
  const initial = await f.snapshot()
  assert.equal((await f.repository.create(r)).created, true)
  const pending = await f.replay(initial)
  assert.equal(workerNode(pending).activity.status, native ? 'active' : 'unknown')
  assert.equal(workerNode(pending).activity.action, native ? 'waiting_approval' : undefined)
  assert.equal(workerNode(pending).attention.pendingInteractionCount, 1)
  assert.equal(pending.state.interactions.length, 1)
  assert.equal((await f.repository.create(r)).created, false)
  assert.equal(f.data.sequence, Number(pending.asOfSequence))
  await f.repository.cancelPendingForExecution(requester.id, [r.nativeRequestId])
  const canceled = await f.replay(pending)
  assert.equal(workerNode(canceled).activity.status, 'unknown')
  assert.equal(workerNode(canceled).activity.action, undefined)
  assert.equal(workerNode(canceled).attention.pendingInteractionCount, 0)
  assert.deepEqual(canceled.state.interactions, [])
  assertFinalStateAndRetirement(f, r.id)
  await f.repository.cancelPendingForExecution(requester.id, [r.nativeRequestId])
  assert.equal((await f.replay(canceled)).asOfSequence, canceled.asOfSequence)
})

test('real projection: creating another pending request cannot overwrite the selected wait; cancellation selects the remaining one', async () => {
  const f = await ports({ actualProjection: true, records: [] })
  withWorkflowCandidate(f)
  let current = await f.snapshot()
  const first = request('a-first'), second = request('z-second')
  await f.repository.create(first)
  current = await f.replay(current)
  await f.repository.create(second)
  current = await f.replay(current)
  assert.equal(workerNode(current).activity.interactionId, first.id)
  assert.equal(workerNode(current).attention.pendingInteractionCount, 2)
  await f.repository.cancelPendingForExecution(requester.id, [first.nativeRequestId])
  current = await f.replay(current)
  assert.equal(workerNode(current).activity.interactionId, second.id)
  assert.equal(workerNode(current).attention.pendingInteractionCount, 1)
  assertFinalStateAndRetirement(f, first.id)
  await f.repository.cancelPendingForExecution(requester.id, [second.nativeRequestId])
  current = await f.replay(current)
  assert.equal(workerNode(current).activity.status, 'unknown')
  assert.deepEqual(current.state.interactions, [])
})

for (const stop of [false, true]) for (const native of [false, true]) {
  test(`real projection: ${stop ? 'Stop' : 'non-Stop'} retains then retires canceled uncertainty (${native ? 'native row' : 'no native row'})`, async () => {
    const f = await ports({ actualProjection: true, records: [] }), r = request()
    if (native) withWorkflowCandidate(f)
    let current = await f.snapshot()
    await f.repository.create(r)
    current = await f.replay(current)
    await f.boundary(stop)
    current = await f.replay(current)
    await f.repository.cancelPendingForRun(scope.runId)
    current = await f.replay(current)
    assert.equal(current.state.interactions[0].resumeState, 'unknown')
    assert.equal(workerNode(current).activity.status, stop ? 'none' : 'unknown')
    assert.equal(retirements(f).length, 0)
    await assert.rejects(f.repository.coordination.finishStoppedReviews(scope.runId, true), { code: 'UNCONFIRMED_NATIVE_CLOSURE' })
    await f.replay(current)
    f.data.nativeClosed = true; f.data.credentialsRevoked = true
    await f.repository.coordination.finishStoppedReviews(scope.runId, true)
    current = await f.replay(current)
    assert.equal(current.state.run.stopRequested, stop)
    assert.deepEqual(current.state.interactions, [])
    assertFinalStateAndRetirement(f, r.id)
    await f.repository.coordination.finishStoppedReviews(scope.runId, true)
    assert.equal((await f.replay(current)).asOfSequence, current.asOfSequence)
  })
}

for (const obligation of ['attempt', 'resume', 'review']) test(`real projection: direct cancellation keeps the ${obligation} obligation without inventing activity`, async () => {
  const f = await ports({ actualProjection: true, records: [] }), r = request()
  if (obligation === 'review') r.approval = { handler: 'orchestrator' }
  // Pre-existing rows isolate retention policy; production attempt/review
  // admission is exercised by the PostgreSQL suite, not by these SQL ports.
  if (obligation === 'attempt') f.data.attempts.set(r.id, { state: 'uncertain' })
  if (obligation === 'resume') f.data.resumes.set(r.id, { state: 'pending', ack: null })
  if (obligation === 'review') f.data.jobs.set('job-one', { id: 'job-one', interactionId: r.id,
    state: 'submitted', revision: 2, attempt: 1, submittedAt: '2026-09-22T00:00:00.000Z' })
  // Review fixture needs an existing request FK; establish its initial cut
  // without replaying fixture setup, then exercise the real cancellation.
  if (obligation === 'review') {
    f.data.records.set(r.id, r)
  } else {
    const initial = await f.snapshot()
    await f.repository.create(r)
    await f.replay(initial)
  }
  const initial = await f.snapshot()
  await f.repository.cancelPendingForExecution(requester.id, [r.nativeRequestId])
  const current = await f.replay(initial)
  assert.equal(current.state.interactions[0].status, 'canceled')
  assert.equal(current.state.interactions[0].resumeState, 'unknown')
  assert.equal(workerNode(current).activity.status, 'unknown')
  assert.equal(retirements(f).length, 0)
  if (obligation === 'review') {
    assert.equal(current.state.reviews.length, 1)
    assert.equal(current.state.run.unsettledReviewCount, 1)
  }
})

test('real projection: failed creation publication leaves the full snapshot and receipts unchanged', async () => {
  const f = await ports({ actualProjection: true, records: [] }), initial = await f.snapshot()
  f.data.failBeforeCommit = true
  await assert.rejects(f.repository.create(request()), /injected-before-commit/)
  assert.deepEqual(await f.snapshot(), initial)
  assert.equal(f.data.receipts.size, 0)
  assert.equal(f.data.batches.length, 0)
})

for (const native of [false, true]) test(`real projection: delivery/continuation remains separate from cancellation and retirement (${native ? 'native row' : 'no native row'})`, async () => {
  const f = await ports({ actualProjection: true, records: [] }), r = request()
  if (native) withWorkflowCandidate(f)
  let current = await f.snapshot()
  await f.repository.create(r)
  current = await f.replay(current)
  // Exercise the owning publisher and mapper at each proposed state. These are
  // not real delivery service/effect-authority calls; the DB test covers those.
  for (const deliveryState of ['pending', 'submitted', 'uncertain', 'delivered']) {
    await f.transact(async (publication) => {
      const previous = f.data.records.get(r.id)
      const next = f.publication.nextInteraction(previous, { status: deliveryState === 'delivered' ? 'delivered' : 'delivery_pending',
        deliveryState, selectedOptionId: 'approve-once', selectedSemantic: 'approve_once' })
      await f.publication.publishInteraction(publication, f.contextFor(previous), previous, next)
    })
    current = await f.replay(current)
    assert.equal(workerNode(current).activity.status, 'unknown')
    assert.equal(current.state.run.pendingInteractionCount, 1)
    assert.equal(current.state.interactions[0].resumeState, deliveryState === 'delivered' ? 'pending' : 'not_started')
    assert.equal(current.state.interactions[0].resumeAcknowledgementId, undefined)
  }
  f.data.attempts.set(r.id, { state: 'delivered', correlationId: 'response-one' })
  f.data.resumes.set(r.id, { state: 'pending', revision: 1, ack: null })
  await f.boundary(true)
  current = await f.replay(current)
  await f.repository.cancelPendingForRun(scope.runId)
  current = await f.replay(current)
  assert.equal(current.state.interactions[0].status, 'canceled')
  assert.equal(current.state.interactions[0].deliveryState, 'delivered')
  assert.equal(current.state.interactions[0].resumeState, 'unknown')
  assert.equal(retirements(f).length, 0)
  const attempt = structuredClone(f.data.attempts.get(r.id)), resume = structuredClone(f.data.resumes.get(r.id))
  f.data.nativeClosed = true; f.data.credentialsRevoked = true
  await f.repository.coordination.finishStoppedReviews(scope.runId, true)
  current = await f.replay(current)
  assert.deepEqual(current.state.interactions, [])
  assert.deepEqual(f.data.attempts.get(r.id), attempt)
  assert.deepEqual(f.data.resumes.get(r.id), resume)
  assertFinalStateAndRetirement(f, r.id)
})
