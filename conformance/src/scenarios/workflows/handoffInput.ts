import assert from 'node:assert/strict'
import { RunAcceptedInputValueSchema } from '@foreman-code/contracts/wave25'

/** Run inspection accepts an object input and retains the complete work activation. */
export function handoffReadInput(value: unknown) {
  const input = RunAcceptedInputValueSchema.parse(value)
  assert.ok('work' in input, 'The public execution detail must contain its accepted work activation.')
  return input
}
