import assert from 'node:assert/strict'
import test from 'node:test'
import { retainedHeavyJobTokens } from './heavy-job-slots.mjs'

test('reserves unresolved acquired work without blocking the remaining queued tickets', () => {
  const slots = [{ token: 'first' }, { token: 'second' }]
  const tickets = [{ token: 'retained', phase: 'running', pgid: 100 },
    ...slots.map(slot => ({ ...slot, phase: 'running' })), { token: 'waiting', phase: 'queued', pgid: null }]
  const retained = retainedHeavyJobTokens(tickets, slots, { multiSlotGate: true })
  assert.deepEqual([...retained], ['retained'])
  assert.equal(slots.length + retained.size, 3)
  assert.equal(retained.has('waiting'), false)
})

test('does not count a legacy owner or registered ticket twice', () => {
  const tickets = [{ token: 'legacy', phase: 'running' }, { token: 'registered', phase: 'acquiring' },
    { token: 'unknown', phase: 'acquiring' }, { token: 'unknown', phase: 'running' }]
  assert.deepEqual([...retainedHeavyJobTokens(tickets, [{ token: 'registered' }], { token: 'legacy' })], ['unknown'])
})

test('retains prior unphased process groups and excludes never-launched coordinators', () => {
  const tickets = [{ token: 'prior', pgid: 100 }, { token: 'waiting', pgid: null },
    { token: 'queued', phase: 'queued', pgid: null }, null]
  assert.deepEqual([...retainedHeavyJobTokens(tickets, [], undefined)], ['prior'])
})
