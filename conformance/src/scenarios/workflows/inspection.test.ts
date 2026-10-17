import { describe, expect, it } from 'vitest'
import { makeCurrentWorkflowFixture, RepeatOccurrenceIdentityV1Schema } from '@foreman-code/contracts/wave25'
import { executionKey } from './inspection.js'

const fixture = makeCurrentWorkflowFixture('inspection-coordinate-regression', 'repeat')
const node = fixture.identities[0]!
const otherNode = fixture.identities[1]!
const firstOccurrence = RepeatOccurrenceIdentityV1Schema.parse({ scope: fixture.scope, blockId: 'repair',
  occurrenceId: 'first-occurrence', occurrenceIndex: 1 })
const secondOccurrence = RepeatOccurrenceIdentityV1Schema.parse({ ...firstOccurrence,
  occurrenceId: 'second-occurrence', occurrenceIndex: 2 })

describe('public execution expectation identity', () => {
  it('keeps ordinary attempts and interval ticks independently addressable', () => {
    const values = new Map([
      [executionKey(node.workflowNodeId, 1, undefined, undefined), 'graph attempt one'],
      [executionKey(node.workflowNodeId, 2, undefined, undefined), 'graph attempt two'],
      [executionKey(node.workflowNodeId, 1, undefined, 1), 'first interval check'],
      [executionKey(node.workflowNodeId, 1, undefined, 2), 'second interval check'],
    ])
    expect(values.size).toBe(4)
    expect(values.get(executionKey(node.workflowNodeId, node.attempt, undefined, undefined))).toBe('graph attempt one')
    expect(values.get(executionKey(node.workflowNodeId, 1, undefined, 2))).toBe('second interval check')
  })

  it('matches parsed repeat readback without conflating nodes, occurrences, or ticks', () => {
    const values = new Map([
      [executionKey(node.workflowNodeId, 1, firstOccurrence, undefined), 'first producer'],
      [executionKey(otherNode.workflowNodeId, 1, firstOccurrence, undefined), 'first reviewer'],
      [executionKey(node.workflowNodeId, 1, secondOccurrence, undefined), 'second producer'],
      [executionKey(node.workflowNodeId, 1, secondOccurrence, 1), 'second producer check'],
    ])
    const readback = RepeatOccurrenceIdentityV1Schema.parse(structuredClone(secondOccurrence))
    expect(values.size).toBe(4)
    expect(values.get(executionKey(node.workflowNodeId, 1, readback, undefined))).toBe('second producer')
    expect(values.get(executionKey(node.workflowNodeId, 1, readback, 1))).toBe('second producer check')
  })
})
