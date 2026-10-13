import { expect, it } from 'vitest'
import { CiRunInputSchema, OperatorCiRunInputSchema } from './ci.js'

it('accepts a full gate through the shared CI request contract', () => {
  const input = { suite: 'integration', scope: 'full', gate: true, commandId: 'gate', commit: 'a'.repeat(40) }
  expect(OperatorCiRunInputSchema.parse({ ...input, workspaceId: 'workspace' })).toMatchObject(input)
  expect(CiRunInputSchema.parse(input)).toMatchObject(input)
})

it('rejects gate requests that select only part of the gate', () => {
  for (const input of [
    { suite: 'unit', scope: 'full' },
    { suite: 'integration', scope: 'affected' },
    { suite: 'integration', scope: 'full', partitions: 2 },
    { suite: 'integration', scope: 'full', files: ['apps/api/test/site.integration.test.ts'] },
  ]) {
    expect(OperatorCiRunInputSchema.safeParse({ ...input, gate: true, commandId: 'gate', workspaceId: 'workspace' })
      .success).toBe(false)
  }
})
