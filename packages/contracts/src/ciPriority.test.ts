import { expect, it } from 'vitest'
import { CiRunInputSchema, OperatorCiRunInputSchema } from './ci.js'
import { DEFAULT_MANAGEMENT_ACTIONS, ManagementGrantSchema } from './management/principals.js'

it('accepts priority for Agent and Operator CI requests and rejects unknown values', () => {
  for (const priority of ['normal', 'high']) {
    const input = { suite: 'lint', commandId: 'priority-command', priority }
    expect(CiRunInputSchema.parse(input).priority).toBe(priority)
    expect(OperatorCiRunInputSchema.parse({ ...input, workspaceId: 'workspace' }).priority).toBe(priority)
  }
  expect(CiRunInputSchema.safeParse({ suite: 'lint', commandId: 'priority-command', priority: 'urgent' }).success)
    .toBe(false)
  expect(CiRunInputSchema.safeParse({ suite: 'lint', commandId: 'default-priority' }).success).toBe(true)
})

it('requires explicit selection of the priority grant in broad permission presets', () => {
  expect(DEFAULT_MANAGEMENT_ACTIONS).not.toContain('jobs:prioritize')
  expect(ManagementGrantSchema.parse({ actions: ['jobs:prioritize'], scope: { workspaceIds: ['workspace'] } }).actions)
    .toEqual(['jobs:prioritize'])
})
