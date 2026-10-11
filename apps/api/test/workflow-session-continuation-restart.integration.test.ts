import { afterEach, describe, it, vi } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { assertWorkflowSessionContinuation } from './helpers/workflowSessionContinuation.js'

afterEach(() => vi.restoreAllMocks())

describe.skipIf(!postgresEnabled)('same-node native session continuity', () => {
  it('resumes persisted history and settles separate lifetimes (restart=true)', async () => {
    await assertWorkflowSessionContinuation({ restart: true })
  }, 120_000)
})
