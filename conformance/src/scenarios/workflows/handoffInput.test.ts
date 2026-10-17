import { describe, expect, it } from 'vitest'
import { makeCurrentWorkflowFixture, RunAcceptedInputValueSchema, WorkActivationInputSchema } from '@foreman-code/contracts/wave25'
import { handoffReadInput } from './handoffInput.js'

const fixture = makeCurrentWorkflowFixture('public-handoff-input-regression', 'single')
const nativeInput = WorkActivationInputSchema.parse({ executionSemanticsVersion: 3,
  runInput: { task: 'Preserve the original request', nested: { revision: 67, values: ['λ雪', null, true] } },
  occurrence: null, entry: null, predecessors: [],
  work: { kind: 'entry', activation: { scope: fixture.scope, activationId: 'entry-activation',
    workflowNodeId: fixture.version.entryNodeId, lineageId: fixture.run.id, cause: { kind: 'entry' } } } })

describe('handoff input at the public execution readback boundary', () => {
  it('retains the complete object input and activation under the generated public contract', () => {
    const input = handoffReadInput(nativeInput)
    const accepted: ReturnType<typeof RunAcceptedInputValueSchema.parse> = input
    expect(accepted).toEqual(nativeInput)
    expect(input.work.activation.scope).toEqual(fixture.scope)
    expect(input.runInput).toEqual(nativeInput.runInput)
  })

  it('rejects native-only scalar, array, and null inputs instead of widening the public object contract', () => {
    for (const runInput of ['native scalar', ['native array'], null]) {
      const native = WorkActivationInputSchema.parse({ ...nativeInput, runInput })
      expect(() => handoffReadInput(native)).toThrow()
    }
  })

  it('rejects an ordinary graph input when an accepted work activation is required', () => {
    const ordinary = RunAcceptedInputValueSchema.parse({ executionSemanticsVersion: 3,
      runInput: fixture.run.input, occurrence: null, entry: null, predecessors: [] })
    expect(() => handoffReadInput(ordinary)).toThrow('The public execution detail must contain its accepted work activation.')
  })
})
