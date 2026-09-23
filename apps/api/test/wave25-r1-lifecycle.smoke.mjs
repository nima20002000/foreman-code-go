/* global console */
/** Dependency-free pure-source regression. Run with Node 22.16:
 * node --experimental-strip-types apps/api/test/wave25-r1-lifecycle.smoke.mjs
 * This imports the actual production mapper; it is NOT a database/native test. */
import assert from 'node:assert/strict'
import {
  publicNodeLifecycle, publicNodeState, publicInteractionPending,
  publicReviewCleanupPending, publicReviewUnsettled, publicReviewRetirementFacts,
} from '../src/modules/run-graph/publicLifecycle.ts'

let checks = 0
const check = (name, action) => { action(); checks++; console.log(`PASS ${name}`) }
const identity = { workflowNodeId: 'node-1', executionId: 'exec-1', agentId: 'agent-1',
  agentConfigurationVersionId: 'cfg-1', attempt: 1 }
const current = (state = 'running', outcome) => ({ execution: identity, state, ...(outcome ? { outcome } : {}) })
const activity = { workflowNodeId: identity.workflowNodeId, execution: identity, status: 'active',
  action: 'working', acknowledgementId: 'native-ack-1', correlationId: 'correlation-1' }
const candidate = (patch = {}, keyPatch = {}) => ({ key: { execution: identity, workKind: 'workflow',
  workId: identity.executionId, ...keyPatch }, activity: { ...activity, ...patch }, lastNativeSequence: '1' })
const state = (execution, native = [], closed = false, blocked = false) =>
  publicNodeState(identity.workflowNodeId, execution, undefined, native, closed, blocked)
const equalLifecycle = (actual, expected) => assert.equal(actual.lifecycle, expected)

for (const raw of ['starting', 'running']) check(`${raw} bookkeeping without evidence stays starting`, () => {
  equalLifecycle(state(current(raw)), 'starting')
})
for (const raw of ['queued', 'waiting']) check(`${raw} remains a durable domain fact`, () => {
  equalLifecycle(state(current(raw)), raw)
})
check('unactivated node has no execution', () => assert.deepEqual(state(undefined), { workflowNodeId: 'node-1', lifecycle: 'not_activated' }))
check('exact native acknowledgement projects running', () => equalLifecycle(state(current(), [candidate()]), 'running'))
for (const status of ['stale', 'unknown', 'none']) check(`${status} native activity is not running`, () => {
  equalLifecycle(state(current(), [candidate({ status })]), 'unknown')
})
for (const field of ['acknowledgementId', 'correlationId', 'action']) check(`missing ${field} cannot acknowledge`, () => {
  equalLifecycle(state(current(), [candidate({ [field]: undefined })]), 'unknown')
})
for (const action of ['reviewing', 'waiting_approval']) check(`${action} cannot acknowledge workflow work`, () => {
  equalLifecycle(state(current(), [candidate({ action })]), 'unknown')
})
check('review work cannot acknowledge the host workflow', () => equalLifecycle(state(current(), [candidate({}, { workKind: 'review', workId: 'job-1' })]), 'starting'))
check('wrong workflow work ID is ignored', () => equalLifecycle(state(current(), [candidate({}, { workId: 'other' })]), 'starting'))
for (const field of ['workflowNodeId', 'executionId', 'agentId', 'agentConfigurationVersionId', 'attempt']) {
  check(`mismatched key ${field} cannot acknowledge`, () => {
    const wrong = { ...identity, [field]: field === 'attempt' ? 2 : 'wrong' }
    equalLifecycle(state(current(), [candidate({}, { execution: wrong })]), 'starting')
  })
  check(`mismatched activity ${field} cannot acknowledge`, () => {
    const wrong = { ...identity, [field]: field === 'attempt' ? 2 : 'wrong' }
    equalLifecycle(state(current(), [candidate({ execution: wrong })]), 'starting')
  })
}
check('mismatched activity node is ignored', () => equalLifecycle(state(current(), [candidate({ workflowNodeId: 'other' })]), 'starting'))
check('ambiguous duplicate candidates fail closed', () => equalLifecycle(state(current(), [candidate(), candidate()]), 'unknown'))
check('an approval obligation blocks reuse of old acknowledgement', () => equalLifecycle(state(current(), [candidate()], false, true), 'unknown'))
check('durable wait is preserved while approval is outstanding', () => equalLifecycle(state(current('waiting'), [candidate()], false, true), 'waiting'))
check('Stop without a terminal result is unknown, not canceled', () => equalLifecycle(state(current(), [candidate()], true), 'unknown'))
check('interrupted or unrecognized raw states are unknown', () => {
  for (const raw of ['interrupted', 'disconnected', 'invented']) assert.equal(publicNodeLifecycle(raw), 'unknown')
})
for (const outcome of ['succeeded', 'failed', 'canceled']) {
  check(`terminal ${outcome} is visible before acceptance`, () => {
    const value = state(current('completed', outcome))
    equalLifecycle(value, outcome)
    assert.equal(value.resolution, undefined)
    assert.equal(value.acceptedResultDigest, undefined)
  })
  check(`confirmed ${outcome} survives Stop and independent review activity`, () => {
    equalLifecycle(state(current('completed', outcome), [candidate({}, { workKind: 'review', workId: 'job-1' })], true, true), outcome)
  })
}
check('completed without a supported outcome is not success', () => {
  for (const outcome of [undefined, 'pending', 'interrupted', 'invalid']) equalLifecycle(state(current('completed', outcome)), 'unknown')
})
for (const resolution of ['succeeded', 'failed', 'canceled', 'skipped', 'excluded']) check(`accepted resolution ${resolution} is authoritative`, () => {
  assert.equal(publicNodeLifecycle('running', undefined, resolution), resolution === 'excluded' ? 'not_activated' : resolution)
})
for (const status of ['pending', 'decided', 'delivery_pending', 'delivery_failed', 'delivered']) check(`${status} retains the approval obligation before native continuation`, () => {
  assert.equal(publicInteractionPending(status), true)
})
check('delivery/checkpoint settlement alone is not native continuation', () => assert.equal(publicInteractionPending('delivered', false), true))
check('qualified native continuation settles the obligation', () => assert.equal(publicInteractionPending('delivered', true), false))
check('cancellation settles the obligation without claiming resumption', () => assert.equal(publicInteractionPending('canceled'), false))
for (const reviewState of ['pending', 'leased', 'submitted', 'acknowledged', 'uncertain', 'blocked_busy', 'blocked_disconnected']) {
  check(`review ${reviewState} remains unsettled without inventing cleanup`, () => {
    const job = { id: 'job-1', state: reviewState }
    assert.equal(publicReviewUnsettled(job), true)
    assert.equal(publicReviewCleanupPending(job), false)
    assert.deepEqual(publicReviewRetirementFacts(job, '9'), [])
  })
}
check('failed unclosed review remains visible with cleanup attention', () => {
  const job = { id: 'job-1', state: 'failed', cleanup: { nativeState: 'pending', credentialState: 'revoked' } }
  assert.equal(publicReviewUnsettled(job), true)
  assert.equal(publicReviewCleanupPending(job), true)
  assert.deepEqual(publicReviewRetirementFacts(job, '9'), [])
})
check('successful review has an explicit retirement fact', () => {
  const job = { id: 'job-1', state: 'completed' }
  assert.equal(publicReviewUnsettled(job), false)
  assert.equal(publicReviewCleanupPending(job), false)
  assert.deepEqual(publicReviewRetirementFacts(job, '9'), [{ type: 'exchange.retired', exchangeKind: 'review', exchangeId: 'job-1', finalRevision: '9' }])
})
check('confirmed failed-review cleanup retires only after both resources settle', () => {
  const cleanup = { nativeState: 'closed', credentialState: 'revoked', completedAt: '2026-09-22T00:00:00.000Z' }
  const job = { id: 'job-1', state: 'failed', cleanup }
  assert.equal(publicReviewUnsettled(job), false)
  assert.equal(publicReviewCleanupPending(job), false)
  assert.equal(publicReviewRetirementFacts(job, '10').length, 1)
  for (const key of ['nativeState', 'credentialState']) {
    assert.deepEqual(publicReviewRetirementFacts({ ...job, cleanup: { ...cleanup, [key]: 'pending' } }, '10'), [])
  }
})
console.log(JSON.stringify({ kind: 'pure-source-smoke', passed: checks, failed: 0,
  databaseExecuted: false, nativeProducerExecuted: false, repositorySuiteExecuted: false }))
