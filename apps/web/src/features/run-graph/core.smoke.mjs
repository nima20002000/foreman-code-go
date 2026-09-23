// Dependency-free checks of the actual production modules; also run by the web test script.
// Standalone (Node 22.6+ with type stripping): corepack pnpm test:run-graph-smoke
// node --experimental-strip-types --test src/features/run-graph/core.smoke.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSerialLoop } from './serialLoop.ts'
import { presentRunGraphNode } from './presentation.ts'

function clock() {
  const pending = new Map()
  let sequence = 0
  return {
    pending,
    schedule(work, delay) { pending.set(++sequence, { work, delay }); return sequence },
    cancel(key) { pending.delete(key) },
    tick() { const first = [...pending][0]; if (first) { pending.delete(first[0]); first[1].work() } },
  }
}
const flush = async () => { await Promise.resolve(); await Promise.resolve() }

test('one request and one timer; wake does not overlap in-flight work', async () => {
  const timer = clock()
  let resolve
  let calls = 0
  const loop = createSerialLoop(() => { calls++; return new Promise((done) => { resolve = done }) }, assert.fail, timer)
  assert.equal(timer.pending.size, 1)
  timer.tick(); loop.wake(); timer.tick()
  assert.equal(calls, 1)
  assert.equal(timer.pending.size, 0)
  resolve(1000); await flush()
  assert.deepEqual([...timer.pending.values()].map((entry) => entry.delay), [1000])
  loop.dispose(); assert.equal(timer.pending.size, 0)
})
test('a response ignoring AbortSignal cannot restart a disposed epoch', async () => {
  const timer = clock()
  let resolve
  const loop = createSerialLoop(() => new Promise((done) => { resolve = done }), assert.fail, timer)
  timer.tick(); loop.dispose(); resolve(0); await flush()
  assert.equal(loop.signal.aborted, true)
  assert.equal(timer.pending.size, 0)
})
test('explicit retry of a settled poll has exactly one timer', async () => {
  const timer = clock()
  let calls = 0
  const loop = createSerialLoop(async () => { calls++; return false }, assert.fail, timer)
  timer.tick(); await flush()
  loop.wake(); loop.wake()
  assert.equal(timer.pending.size, 1)
  timer.tick(); await flush()
  assert.equal(calls, 2)
  loop.dispose()
})
test('unexpected task failures surface once without an infinite retry loop', async () => {
  const timer = clock()
  const failure = new Error('synthetic failure')
  const errors = []
  const loop = createSerialLoop(async () => { throw failure }, (error) => errors.push(error), timer)
  timer.tick(); await flush()
  assert.deepEqual(errors, [failure]); assert.equal(timer.pending.size, 0)
  loop.dispose()
})
const identity = { workflowNodeId: 'n', executionId: 'e', agentId: 'a', agentConfigurationVersionId: 'cfg', attempt: 1 }
function node(lifecycle, activity, telemetry) {
  return { state: { workflowNodeId: 'n', lifecycle, execution: identity }, activity: { workflowNodeId: 'n', ...activity },
    attention: { workflowNodeId: 'n', cleanupPending: false, unsettledReviewCount: 0, pendingInteractionCount: 0, telemetry } }
}
for (const state of ['unknown', 'uncertain', 'interrupted']) test(`${state} is explicit, never Idle/Working/success/failure`, () => {
  const result = presentRunGraphNode(node(state, { status: 'unknown' }, 'unknown'))
  assert.equal(result.activity, 'Activity unavailable')
  assert.equal(result.tone, 'neutral')
  assert.doesNotMatch(result.lifecycle, /Idle|Working|Succeeded|Failed/)
})
for (const status of ['unknown', 'stale']) test(`${status} activity without evidence stays unavailable even with current telemetry`, () => {
  assert.deepEqual(presentRunGraphNode(node('running', { status }, 'current')),
    { lifecycle: 'Running', activity: 'Activity unavailable', tone: 'neutral' })
})
test('native work requires both acknowledgement and correlation', () => {
  const activity = { status: 'active', action: 'working', execution: identity }
  const unavailable = { lifecycle: 'Running', activity: 'Activity unavailable', tone: 'neutral' }
  assert.deepEqual(presentRunGraphNode(node('running', activity, 'current')), unavailable)
  assert.deepEqual(presentRunGraphNode(node('running', { ...activity, acknowledgementId: 'ack' }, 'current')), unavailable)
  assert.deepEqual(presentRunGraphNode(node('running', { ...activity, correlationId: 'corr' }, 'current')), unavailable)
})
test('reviewing requires both its review and interaction, not just acknowledgement', () => {
  const activity = { status: 'active', action: 'reviewing', execution: identity, acknowledgementId: 'ack', correlationId: 'corr' }
  const unavailable = { lifecycle: 'Running', activity: 'Activity unavailable', tone: 'neutral' }
  assert.deepEqual(presentRunGraphNode(node('running', activity, 'current')), unavailable)
  assert.deepEqual(presentRunGraphNode(node('running', { ...activity, reviewJobId: 'r' }, 'current')), unavailable)
  assert.deepEqual(presentRunGraphNode(node('running', { ...activity, interactionId: 'i' }, 'current')), unavailable)
})
for (const [action, label, review] of [['working', 'Working', {}], ['reviewing', 'Reviewing', { reviewJobId: 'r', interactionId: 'i' }]]) {
  const activity = { status: 'active', action, execution: identity, acknowledgementId: 'ack', correlationId: 'corr', ...review }
  for (const telemetry of ['current', 'unknown', 'stale']) test(`${action} with ${telemetry} telemetry preserves its evidence confidence`, () => {
    assert.deepEqual(presentRunGraphNode(node('running', activity, telemetry)), {
      lifecycle: 'Running',
      activity: telemetry === 'current' ? label : `Last known: ${label} · updates unconfirmed`,
      tone: telemetry === 'current' ? 'accent' : 'neutral',
    })
  })
  test(`acknowledged stale ${action} stays last-known despite current telemetry`, () => {
    assert.deepEqual(presentRunGraphNode(node('running', { ...activity, status: 'stale' }, 'current')),
      { lifecycle: 'Running', activity: `Last known: ${label} · updates unconfirmed`, tone: 'neutral' })
  })
  test(`stale ${action} without acknowledgement or correlation stays unavailable`, () => {
    for (const missing of ['acknowledgementId', 'correlationId']) {
      const incomplete = { ...activity, status: 'stale' }
      delete incomplete[missing]
      assert.deepEqual(presentRunGraphNode(node('running', incomplete, 'current')),
        { lifecycle: 'Running', activity: 'Activity unavailable', tone: 'neutral' }, missing)
    }
  })
}
test('stale unsupported or mismatched execution evidence cannot become last-known work', () => {
  const activity = { status: 'stale', action: 'working', execution: identity, acknowledgementId: 'ack', correlationId: 'corr' }
  for (const invalid of [{ action: 'unsupported' }, { execution: undefined }, { execution: { ...identity, executionId: 'other' } }]) {
    assert.deepEqual(presentRunGraphNode(node('running', { ...activity, ...invalid }, 'current')),
      { lifecycle: 'Running', activity: 'Activity unavailable', tone: 'neutral' })
  }
})
test('extra polling/connection fields cannot produce semantic activity', () => {
  const fact = { ...node('queued', { status: 'unknown' }, 'current'), connected: true, reconnecting: false, ping: true, polling: true }
  assert.deepEqual(presentRunGraphNode(fact), { lifecycle: 'Queued', activity: 'Activity unavailable', tone: 'neutral' })
})
test('transport/current activity cannot substitute for terminal lifecycle', () => {
  const activity = { status: 'active', action: 'working', execution: identity, acknowledgementId: 'ack', correlationId: 'corr' }
  assert.deepEqual(presentRunGraphNode(node('canceled', activity, 'current')),
    { lifecycle: 'Canceled', activity: 'Activity unavailable', tone: 'neutral' })
})
