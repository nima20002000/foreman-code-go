// Dependency-free checks of the actual production modules. Run separately from Vitest:
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
function node(lifecycle, activity) {
  return { state: { workflowNodeId: 'n', lifecycle, execution: identity }, activity: { workflowNodeId: 'n', ...activity },
    attention: { workflowNodeId: 'n', cleanupPending: false, unsettledReviewCount: 0, pendingInteractionCount: 0, telemetry: 'unknown' } }
}
for (const state of ['unknown', 'uncertain', 'interrupted']) test(`${state} is explicit, never Idle/Working/success/failure`, () => {
  const result = presentRunGraphNode(node(state, { status: 'unknown' }))
  assert.equal(result.activity, 'Activity unavailable')
  assert.doesNotMatch(result.lifecycle, /Idle|Working|Succeeded|Failed/)
})
test('unknown activity and stale activity remain unavailable/stale even with a running lifecycle', () => {
  assert.equal(presentRunGraphNode(node('running', { status: 'unknown' })).activity, 'Activity unavailable')
  assert.equal(presentRunGraphNode(node('running', { status: 'stale' })).activity, 'Activity stale')
})
test('native work requires both acknowledgement and correlation', () => {
  const activity = { status: 'active', action: 'working', execution: identity }
  assert.equal(presentRunGraphNode(node('running', activity)).activity, 'Activity unavailable')
  assert.equal(presentRunGraphNode(node('running', { ...activity, acknowledgementId: 'ack' })).activity, 'Activity unavailable')
  assert.equal(presentRunGraphNode(node('running', { ...activity, acknowledgementId: 'ack', correlationId: 'corr' })).activity, 'Working')
})
test('reviewing requires its exact review and interaction, not a lease or liveness flag', () => {
  const activity = { status: 'active', action: 'reviewing', execution: identity, acknowledgementId: 'ack', correlationId: 'corr' }
  assert.equal(presentRunGraphNode(node('running', activity)).activity, 'Activity unavailable')
  assert.equal(presentRunGraphNode(node('running', { ...activity, reviewJobId: 'r', interactionId: 'i' })).activity, 'Reviewing')
})
test('extra polling/connection fields cannot produce semantic activity', () => {
  const fact = { ...node('queued', { status: 'unknown' }), connected: true, reconnecting: false, ping: true, polling: true }
  assert.equal(presentRunGraphNode(fact).activity, 'Activity unavailable')
  assert.equal(presentRunGraphNode(fact).lifecycle, 'Queued')
})
test('transport/current activity cannot substitute for terminal lifecycle', () => {
  const result = presentRunGraphNode(node('canceled', { status: 'unknown' }))
  assert.equal(result.lifecycle, 'Canceled')
  assert.equal(result.activity, 'Activity unavailable')
})
