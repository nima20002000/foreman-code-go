import assert from 'node:assert/strict'
import type { RunGraphCurrentState } from '@graphql/contracts/wave25'
import { createRunCuePolicy, RUN_CUE_LIMITS, type CueEnvironment } from './cuePolicy'
import { presentRunGraphNode } from './presentation'
import { presentInteraction, presentReview, selectAttentionAnnouncement, selectRelationshipSummary } from './exchangePresentation'
import { addVisualApproval, addVisualReceipt, makeVisualFixture, nextVisualFixture, visualSignal } from './fixtures/visualFixture'

type Register = (name: string, body: () => void) => void
const env = (now: number, extra: Partial<CueEnvironment> = {}): CueEnvironment => ({ now, motion: true, isVisible: () => true, ...extra })
const field = (view: ReturnType<typeof presentInteraction>, name: string) => view.fields.find((x) => x.label === name)?.value
function nativeNode() {
  const node = makeVisualFixture().facts.snapshot.state.nodes[1]!
  node.state.lifecycle = 'running'
  node.activity = { workflowNodeId: node.state.workflowNodeId, status: 'active', action: 'reading_file', execution: node.state.execution!, acknowledgementId: 'ack', correlationId: 'turn' }
  return node
}

/** Shared by pinned Vitest and the dependency-free Node smoke runner; these test the production functions. */
export function registerVisualCases(test: Register) {
  test('all lifecycle distinctions survive presentation; no idle fallback', () => {
    const labels = { not_activated: 'Not activated', queued: 'Queued', starting: 'Starting', running: 'Running', waiting: 'Waiting',
      succeeded: 'Succeeded', failed: 'Failed', canceled: 'Canceled', skipped: 'Skipped', interrupted: 'Interrupted', uncertain: 'Uncertain', unknown: 'Lifecycle unavailable' }
    for (const [lifecycle, label] of Object.entries(labels)) {
      const node = nativeNode()
      node.state.lifecycle = lifecycle as RunGraphCurrentState['nodes'][number]['state']['lifecycle']
      assert.equal(presentRunGraphNode(node).lifecycle, label)
      if (['failed', 'canceled', 'skipped', 'interrupted', 'uncertain', 'unknown'].includes(lifecycle)) assert.equal(presentRunGraphNode(node).activity, 'Activity unavailable')
    }
  })
  test('acknowledgement and correlation are both required for native activity', () => {
    const node = nativeNode()
    assert.equal(presentRunGraphNode(node).activity, 'Reading file')
    delete node.activity.acknowledgementId
    assert.equal(presentRunGraphNode(node).activity, 'Activity unavailable')
    node.activity.acknowledgementId = 'ack'
    delete node.activity.correlationId
    assert.equal(presentRunGraphNode(node).activity, 'Activity unavailable')
  })
  test('execution, attempt and pinned configuration mismatches cannot imply work', () => {
    for (const changed of [{ executionId: 'other' }, { attempt: 2 }, { agentConfigurationVersionId: 'other' }, { workflowNodeId: 'other' }]) {
      const node = nativeNode()
      node.activity.execution = { ...node.state.execution!, ...changed }
      assert.equal(presentRunGraphNode(node).activity, 'Activity unavailable')
    }
  })
  test('a completed step can host acknowledged review without restarting its lifecycle', () => {
    const node = nativeNode()
    node.state.lifecycle = 'succeeded'
    node.activity.action = 'reviewing'; node.activity.reviewJobId = 'review'; node.activity.interactionId = 'request'
    assert.deepEqual(presentRunGraphNode(node), { lifecycle: 'Succeeded', activity: 'Reviewing', tone: 'accent' })
    delete node.activity.reviewJobId
    assert.equal(presentRunGraphNode(node).activity, 'Activity unavailable')
    node.activity.action = 'working'
    assert.equal(presentRunGraphNode(node).activity, 'Activity unavailable')
  })
  test('stale telemetry retains a labeled last-known safe action, without live accent', () => {
    const node = nativeNode()
    for (const stale of ['activity', 'attention', 'transport']) {
      const copy = structuredClone(node)
      if (stale === 'activity') copy.activity.status = 'stale'
      if (stale === 'attention') copy.attention.telemetry = 'stale'
      const view = presentRunGraphNode(copy, { stale: stale === 'transport' })
      assert.equal(view.lifecycle, 'Running'); assert.match(view.activity, /Last known: Reading file/); assert.equal(view.tone, 'neutral')
    }
  })
  test('unsupported actions, missing rows, and unknown lifecycle remain unavailable', () => {
    assert.equal(presentRunGraphNode(undefined).lifecycle, 'Lifecycle unavailable')
    const node = nativeNode()
    Object.assign(node.activity, { action: 'keepalive' })
    assert.equal(presentRunGraphNode(node).activity, 'Activity unavailable')
    Object.assign(node.state, { lifecycle: 'unsupported' })
    assert.equal(presentRunGraphNode(node).lifecycle, 'Lifecycle unavailable')
  })
  test('Stop suppresses activity decoration but does not rewrite lifecycle', () => {
    const view = presentRunGraphNode(nativeNode(), { stopped: true })
    assert.equal(view.lifecycle, 'Running'); assert.match(view.activity, /withheld/); assert.equal(view.tone, 'neutral')
  })
  test('route selection alone is neither an input receipt nor admission/work', () => {
    const record = makeVisualFixture()
    const policy = createRunCuePolicy()
    policy.observe(record, env(0)); policy.accept(visualSignal(record), record, env(0)); policy.tick(record, env(50))
    assert.deepEqual(policy.cues(), [])
    assert.equal(selectRelationshipSummary(record, 'execution-edge-1'), 'Route selected')
    assert.equal(presentRunGraphNode(record.facts.snapshot.state.nodes[1]).activity, 'No current activity')
  })
  test('same-batch offer and receipt produce only receipt confirmation after commit; lifecycle is immediate', () => {
    const before = makeVisualFixture(); const policy = createRunCuePolicy(); policy.observe(before, env(0))
    const current = addVisualReceipt(before, 1)
    policy.accept(visualSignal(current), current, env(0))
    assert.equal(presentRunGraphNode(current.facts.snapshot.state.nodes[1]).lifecycle, 'Queued')
    assert.deepEqual(policy.cues(), [])
    policy.tick(current, env(50))
    assert.equal(policy.cues().length, 1); assert.equal(policy.cues()[0]?.caption, 'Input receipt confirmed')
    assert.equal(presentRunGraphNode(current.facts.snapshot.state.nodes[1]).activity, 'No current activity')
  })
  test('five events in 100ms never exceed four visible cues or leave a FIFO backlog', () => {
    let current = makeVisualFixture(); const policy = createRunCuePolicy(); policy.observe(current, env(0))
    for (let i = 1; i <= 5; ++i) {
      const now = (i - 1) * 20
      policy.tick(current, env(now))
      current = addVisualReceipt(current, i); policy.accept(visualSignal(current), current, env(now))
      assert.ok(policy.cues().length <= 4)
    }
    policy.tick(current, env(130)); assert.equal(policy.cues().length, 4)
    assert.equal(new Set(policy.cues().map((x) => x.key)).size, policy.cues().length)
    policy.tick(current, env(500)); assert.deepEqual(policy.cues(), []); assert.equal(policy.nextWakeAt(), undefined)
    policy.tick(current, env(5000)); assert.deepEqual(policy.cues(), [])
  })
  test('duplicate accepted metadata cannot restart a cue or replay it after expiry', () => {
    const before = makeVisualFixture(); const policy = createRunCuePolicy(); policy.observe(before, env(0))
    const current = addVisualReceipt(before, 1); const signal = visualSignal(current)
    policy.accept(signal, current, env(0)); policy.tick(current, env(50)); const cue = policy.cues()[0]
    policy.accept(signal, current, env(100)); assert.equal(policy.cues()[0], cue)
    policy.tick(current, env(350)); policy.accept(signal, current, env(400)); policy.tick(current, env(450))
    assert.deepEqual(policy.cues(), [])
  })
  test('initial snapshots, reconnect/catch-up and empty polls do not animate history', () => {
    const snapshot = addVisualReceipt(makeVisualFixture(), 1)
    const policy = createRunCuePolicy(); policy.observe(snapshot, env(0))
    policy.accept(visualSignal(snapshot), snapshot, env(0)); policy.tick(snapshot, env(50)); assert.deepEqual(policy.cues(), [])
    const next = addVisualReceipt(snapshot, 2)
    policy.accept(visualSignal(next, 'catchup'), next, env(100)); policy.tick(next, env(150)); assert.deepEqual(policy.cues(), [])
    policy.accept(visualSignal(next), next, env(200)); policy.tick(next, env(250)); assert.deepEqual(policy.cues(), [])
  })
  test('only the final current-cut callback is eligible; large decimal positions stay exact', () => {
    const before = makeVisualFixture(); const policy = createRunCuePolicy(); policy.observe(before, env(0))
    const current = addVisualReceipt(before, 1); current.facts.snapshot.asOfSequence = '9007199254740993'
    const signal = visualSignal(current)
    policy.accept({ ...signal, sequence: '9007199254740992' }, current, env(0)); policy.tick(current, env(50)); assert.deepEqual(policy.cues(), [])
    policy.accept(signal, current, env(100)); policy.tick(current, env(150)); assert.equal(policy.cues().length, 1)
  })
  test('wrong Run/version or old epoch callback cannot animate current facts', () => {
    const before = makeVisualFixture(); const policy = createRunCuePolicy(); policy.observe(before, env(0))
    const current = addVisualReceipt(before, 1); const signal = visualSignal(current)
    policy.accept({ ...signal, scope: { ...signal.scope, workflowVersionId: 'new-draft' } }, current, env(0))
    policy.accept({ ...signal, epoch: 0 }, current, env(0)); policy.tick(current, env(50)); assert.deepEqual(policy.cues(), [])
  })
  test('new epoch silently baselines current facts and cancels old effects', () => {
    const before = makeVisualFixture(); const policy = createRunCuePolicy(); policy.observe(before, env(0))
    const current = addVisualReceipt(before, 1); policy.accept(visualSignal(current), current, env(0)); policy.tick(current, env(50))
    const reset = { ...current, epoch: 2 }; policy.observe(reset, env(60)); assert.deepEqual(policy.cues(), [])
    policy.accept(visualSignal(reset), reset, env(100)); policy.tick(reset, env(150)); assert.deepEqual(policy.cues(), [])
  })
  test('Stop and Run failure cancel active and queued effects immediately', () => {
    for (const kind of ['stop', 'failure']) {
      const before = makeVisualFixture(); const policy = createRunCuePolicy(); policy.observe(before, env(0))
      let current = addVisualReceipt(before, 1); policy.accept(visualSignal(current), current, env(0)); policy.tick(current, env(50))
      current = addVisualReceipt(current, 2); policy.accept(visualSignal(current), current, env(60))
      const stopped = nextVisualFixture(current)
      if (kind === 'stop') stopped.facts.snapshot.state.run.stopRequested = true
      else Object.assign(stopped.facts.snapshot.state.run, { executionState: 'completed', outcome: 'failed' })
      policy.observe(stopped, env(61)); assert.deepEqual(policy.cues(), []); assert.equal(policy.nextWakeAt(), undefined)
      policy.tick(stopped, env(110)); assert.deepEqual(policy.cues(), [])
    }
  })
  test('a canceled recipient cancels only its misleading receipt cue', () => {
    const before = makeVisualFixture(); const policy = createRunCuePolicy(); policy.observe(before, env(0))
    const current = addVisualReceipt(addVisualReceipt(before, 1), 2)
    policy.accept(visualSignal(current), current, env(0)); policy.tick(current, env(50)); assert.equal(policy.cues().length, 2)
    const stopped = nextVisualFixture(current); stopped.facts.snapshot.state.nodes[1]!.state.lifecycle = 'canceled'
    policy.observe(stopped, env(60)); assert.deepEqual(policy.cues().map((x) => x.key), ['binding:binding-2'])
  })
  test('pending, failed and uncertain deliveries never become delivery or resumption confirmation', () => {
    for (const delivery of ['pending', 'submitted', 'uncertain', 'failed'] as const) {
      const before = addVisualApproval(makeVisualFixture()); const policy = createRunCuePolicy(); policy.observe(before, env(0))
      const current = nextVisualFixture(before); const request = current.facts.snapshot.state.interactions[0]!
      Object.assign(request, { revision: '2', status: delivery === 'failed' ? 'delivery_failed' : 'delivery_pending',
        deliveryState: delivery, decision: 'approve_once', selectedOptionId: 'approve', resumeState: 'pending' })
      policy.accept(visualSignal(current), current, env(0, { focusedExchangeKey: 'interaction:request-1' })); policy.tick(current, env(50, { focusedExchangeKey: 'interaction:request-1' }))
      assert.deepEqual(policy.cues(), []); assert.match(field(presentInteraction(request), 'Worker resumption')!, /not acknowledged/)
    }
  })
  test('delivery without resume remains delivery only, and approval cues are inspected-only', () => {
    const before = addVisualApproval(makeVisualFixture())
    const current = nextVisualFixture(before); const request = current.facts.snapshot.state.interactions[0]!
    Object.assign(request, { revision: '2', status: 'delivered', deliveryState: 'delivered', decision: 'approve_once', selectedOptionId: 'approve', resumeState: 'pending' })
    for (const focused of [undefined, 'interaction:request-1']) {
      const policy = createRunCuePolicy(); policy.observe(before, env(0))
      policy.accept(visualSignal(current), current, env(0, { focusedExchangeKey: focused })); policy.tick(current, env(50, { focusedExchangeKey: focused }))
      assert.equal(policy.cues().length, focused ? 1 : 0)
      if (focused) assert.equal(policy.cues()[0]?.caption, 'Native delivery confirmed')
    }
    assert.equal(field(presentInteraction(request), 'Worker resumption'), 'Pending; not acknowledged')
    assert.equal(presentReview(current.facts.snapshot.state.reviews[0]!).fields.find((x) => x.label === 'Review state')?.value, 'Review pending')
  })
  test('review lease is not native acknowledgement; simultaneous waits retain exact identities', () => {
    const before = addVisualApproval(addVisualApproval(makeVisualFixture(), 1, 'one'), 1, 'two')
    const leased = nextVisualFixture(before); leased.facts.snapshot.state.reviews[0]!.state = 'leased'
    const policy = createRunCuePolicy(); policy.observe(before, env(0))
    policy.accept(visualSignal(leased), leased, env(0, { focusedExchangeKey: 'review:review-one' })); policy.tick(leased, env(50, { focusedExchangeKey: 'review:review-one' }))
    assert.deepEqual(policy.cues(), [])
    const current = nextVisualFixture(leased)
    Object.assign(current.facts.snapshot.state.interactions[0]!, { revision: '2', status: 'decided', decision: 'approve_once', selectedOptionId: 'approve' })
    const summary = selectRelationshipSummary(current, 'approval-edge-1')
    assert.match(summary, /1 pending requests/); assert.match(summary, /2 unsettled reviews/)
    assert.equal(current.facts.snapshot.state.interactions[1]!.interactionId, 'request-two')
    assert.equal(current.facts.snapshot.state.interactions[1]!.status, 'pending')
  })
  test('native review acknowledgement supports one exact review cue; decision supersedes it', () => {
    const before = addVisualApproval(makeVisualFixture()); const policy = createRunCuePolicy(); policy.observe(before, env(0))
    const current = nextVisualFixture(before)
    Object.assign(current.facts.snapshot.state.reviews[0]!, { revision: '2', state: 'acknowledged', acknowledgementId: 'review-ack' })
    const focus = { focusedExchangeKey: 'review:review-1' }
    policy.accept(visualSignal(current), current, env(0, focus)); policy.tick(current, env(50, focus))
    assert.equal(policy.cues()[0]?.caption, 'Native review acknowledged')
    assert.equal(presentRunGraphNode(current.facts.snapshot.state.nodes[0]).lifecycle, 'Succeeded')
    const decided = nextVisualFixture(current)
    Object.assign(decided.facts.snapshot.state.interactions[0]!, { status: 'decided', decision: 'approve_once', selectedOptionId: 'approve', revision: '2' })
    policy.observe(decided, env(60, focus)); assert.deepEqual(policy.cues(), [])
  })
  test('stale/error/denied/catching-up and unknown Stop telemetry suppress all motion', () => {
    for (const phase of ['stale', 'error', 'denied', 'catching-up', 'resetting'] as const) {
      const before = makeVisualFixture(); const policy = createRunCuePolicy(); policy.observe(before, env(0))
      const current = addVisualReceipt(before, 1); policy.accept(visualSignal(current), current, env(0)); policy.tick(current, env(50))
      policy.observe({ ...current, transport: { phase } }, env(60)); assert.deepEqual(policy.cues(), [])
    }
    const before = makeVisualFixture(); const policy = createRunCuePolicy(); policy.observe(before, env(0))
    const current = addVisualReceipt(before, 1); current.facts.snapshot.state.run.stopRequested = null
    policy.accept(visualSignal(current), current, env(0)); policy.tick(current, env(50)); assert.deepEqual(policy.cues(), [])
  })
  test('reduced motion/background modes retain equivalent static facts and never replay on return', () => {
    const before = makeVisualFixture(); const policy = createRunCuePolicy(); policy.observe(before, env(0))
    const current = addVisualReceipt(before, 1)
    policy.accept(visualSignal(current), current, env(0, { motion: false })); policy.tick(current, env(50, { motion: false }))
    assert.deepEqual(policy.cues(), []); assert.match(selectRelationshipSummary(current, 'execution-edge-1'), /1 input receipts/)
    policy.accept(visualSignal(current), current, env(100)); policy.tick(current, env(150)); assert.deepEqual(policy.cues(), [])
  })
  test('offscreen cues are dropped rather than queued until a later camera move', () => {
    const before = makeVisualFixture(); const policy = createRunCuePolicy(); policy.observe(before, env(0))
    const current = addVisualReceipt(before, 1)
    policy.accept(visualSignal(current), current, env(0, { isVisible: () => false })); policy.tick(current, env(50))
    policy.accept(visualSignal(current), current, env(100)); policy.tick(current, env(150)); assert.deepEqual(policy.cues(), [])
  })
  test('late starts are dropped and cleanup disposes all optional effects', () => {
    const before = makeVisualFixture(); const policy = createRunCuePolicy(); policy.observe(before, env(0))
    const current = addVisualReceipt(before, 1); policy.accept(visualSignal(current), current, env(0))
    policy.tick(current, env(RUN_CUE_LIMITS.maxStartAgeMs + 1)); assert.deepEqual(policy.cues(), [])
    policy.clear(); assert.equal(policy.nextWakeAt(), undefined)
  })
  test('transport/polling and routine native tool operations cannot create exchange cues or announcements', () => {
    const before = makeVisualFixture(); const policy = createRunCuePolicy(); policy.observe(before, env(0))
    const current = nextVisualFixture(before); current.facts.snapshot.state.nodes[1] = nativeNode(); current.transport.confirmedAt = 1000
    policy.accept(visualSignal(current), current, env(0)); policy.tick(current, env(50)); assert.deepEqual(policy.cues(), [])
    assert.equal(selectAttentionAnnouncement(current), selectAttentionAnnouncement(before))
  })
  test('terminal outcome does not clear independent review and cleanup attention', () => {
    const current = addVisualApproval(makeVisualFixture())
    Object.assign(current.facts.snapshot.state.run, { executionState: 'completed', outcome: 'succeeded', cleanupPending: true })
    Object.assign(current.facts.snapshot.state.reviews[0]!, { state: 'failed', nativeCleanup: 'pending', credentialCleanup: 'pending' })
    assert.match(selectAttentionAnnouncement(current), /Cleanup pending/)
    assert.match(selectRelationshipSummary(current, 'approval-edge-1'), /1 unsettled reviews/)
    assert.equal(presentReview(current.facts.snapshot.state.reviews[0]!).fields.find((x) => x.label === 'Native cleanup')?.value, 'pending')
  })
  test('delayed accepted callbacks cannot start a cue more than one second after the Query commit', () => {
    const before = makeVisualFixture(); const policy = createRunCuePolicy(); policy.observe(before, env(0))
    const current = addVisualReceipt(before, 1)
    policy.accept(visualSignal(current), current, env(1001)); policy.tick(current, env(1051))
    assert.deepEqual(policy.cues(), [])
  })
  test('unsupported resumption acknowledgement and malformed settled review stay unavailable', () => {
    const current = addVisualApproval(makeVisualFixture())
    const request = current.facts.snapshot.state.interactions[0]!
    request.resumeState = 'acknowledged'
    assert.equal(field(presentInteraction(request), 'Worker resumption'), 'Resumption unavailable')
    const review = current.facts.snapshot.state.reviews[0]!
    review.state = 'completed'; review.nativeCleanup = 'pending'
    assert.equal(presentReview(review).fields.find((x) => x.label === 'Review state')?.value, 'Review settlement unavailable')
  })
  test('100/300/500 connected synthetic fixtures are bounded and contain no native calls', () => {
    for (const count of [100, 300, 500]) {
      const current = makeVisualFixture(count)
      assert.equal(current.facts.snapshot.topology.nodes.length, count)
      assert.equal(current.facts.snapshot.topology.relationships.length, (count - 1) * 2)
      const frozen = JSON.stringify(current)
      const policy = createRunCuePolicy(); policy.observe(current, env(0)); policy.accept(visualSignal(current), current, env(0))
      assert.equal(JSON.stringify(current), frozen); assert.deepEqual(policy.cues(), [])
    }
  })
}
