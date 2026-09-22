/* global URL */
// Dependency-free checks against the actual new pure source. This is not a
// substitute for the repository's pinned TypeScript/Vitest/PostgreSQL suites.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { nextApprovalResumeValues } from '../src/infrastructure/approvalCheckpointPlan.ts'
import { publicNodeLifecycle } from '../src/modules/run-graph/publicLifecycle.ts'

test('setup, session binding and keepalive cannot establish running lifecycle', () => {
  for (let n = 0; n < 100; n++) assert.equal(publicNodeLifecycle('running'), 'starting')
  assert.equal(publicNodeLifecycle('starting'), 'starting')
  for (const raw of ['unknown', 'disconnected', 'uncertain', 'interrupted', 'ping']) assert.equal(publicNodeLifecycle(raw), 'unknown')
})
test('terminal-before-acceptance remains a terminal execution fact, not a fabricated resolution', () => {
  for (const outcome of ['succeeded', 'failed', 'canceled']) assert.equal(publicNodeLifecycle('completed', outcome), outcome)
  assert.equal(publicNodeLifecycle('completed'), 'unknown')
  assert.equal(publicNodeLifecycle(undefined), 'not_activated')
  assert.equal(publicNodeLifecycle('completed', 'succeeded', 'failed'), 'failed')
  assert.equal(publicNodeLifecycle('queued', undefined, 'excluded'), 'not_activated')
})
test('one current interrupt gets one resume value despite repeated/sibling deliveries', () => {
  const first = nextApprovalResumeValues([], ['a', 'b'], 'a')
  assert.deepEqual(first, { changed: true, values: [{ interactionId: 'a' }] })
  for (const id of ['b', 'a', 'b']) {
    const next = nextApprovalResumeValues(first.values, ['a', 'b'], id)
    assert.equal(next.changed, false)
    assert.equal(next.values, first.values)
  }
})
test('subsequent independent interrupt and multiple task branches have distinct values', () => {
  const a = nextApprovalResumeValues([], ['a'], 'a')
  const b = nextApprovalResumeValues([], ['b'], 'b')
  const later = nextApprovalResumeValues(a.values, ['later'], 'later')
  assert.deepEqual(b.values, [{ interactionId: 'b' }])
  assert.deepEqual(later.values, [{ interactionId: 'a' }, { interactionId: 'later' }])
  assert.deepEqual(a.values, [{ interactionId: 'a' }])
})
test('malformed, foreign, duplicate and oversized resume payloads fail closed', () => {
  for (const previous of [null, {}, 'resume', Array(1001).fill(null)]) assert.throws(() => nextApprovalResumeValues(previous, ['a'], 'a'))
  for (const ids of [[], ['a', 'a'], [''], Array(1001).fill('a')]) assert.throws(() => nextApprovalResumeValues([], ids, 'a'))
  assert.throws(() => nextApprovalResumeValues([], ['a'], 'foreign'))
  assert.throws(() => nextApprovalResumeValues(Array(1000).fill(null), ['new'], 'new'), /GRAPH_RESUME_LIMIT/)
})
test('production source registers the atomic callback and the real saver subclass', () => {
  const production = readFileSync(new URL('../src/production.ts', import.meta.url), 'utf8')
  const store = readFileSync(new URL('../src/infrastructure/checkpoints.ts', import.meta.url), 'utf8')
  const registration = readFileSync(new URL('../src/modules/runs/approvalCheckpointRegistration.ts', import.meta.url), 'utf8')
  assert.match(production, /registerApprovalCheckpointResume\(interactions, engine\)/)
  assert.match(registration, /interactions\.useAtomicApprovalResume\(\(claim\) => engine\.resumeInteraction\(claim\.interaction, claim\)\)/)
  assert.match(store, /new ApprovalPostgresSaver\(pool, undefined, \{ schema \}\)/)
})
test('v2 resume commits the shared consumer before dispatch; legacy command remains separate', () => {
  const engine = readFileSync(new URL('../src/modules/runs/engine.ts', import.meta.url), 'utf8')
  const method = engine.slice(engine.indexOf('  private async resumeCheckpoint('), engine.indexOf('  private buildGraph('))
  const split = method.indexOf('    const resumeMap = ')
  assert.ok(split > 0)
  const v2 = method.slice(0, split)
  assert.ok(v2.indexOf('await consumeDeliveredApprovals') < v2.indexOf('await this.executeRun'))
  assert.doesNotMatch(v2, /new Command/)
  assert.match(method.slice(split), /new Command\(\{ resume: resumeMap \}\)/)
})
test('the atomic saver does not open a second transaction or invoke a graph/provider', () => {
  const source = readFileSync(new URL('../src/infrastructure/approvalCheckpointSaver.ts', import.meta.url), 'utf8')
  const body = source.slice(source.indexOf('  async consumeApprovalInterrupt('))
  assert.doesNotMatch(body, /\b(?:putWrites|put|invoke|respond|startTurn|createSession)\(/)
  assert.match(body, /this\._dumpWrites/)
  assert.match(body, /checkpoint_writes/)
  assert.doesNotMatch(body, /query\(['"`](?:begin|commit)/i)
})
