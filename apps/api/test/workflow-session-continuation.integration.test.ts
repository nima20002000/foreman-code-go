import { afterEach, describe, it, vi } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { assertWorkflowSessionContinuation } from './helpers/workflowSessionContinuation.js'

afterEach(() => vi.restoreAllMocks())

describe.skipIf(!postgresEnabled)('same-node native session continuity', () => {
  it.each([false, true])('resumes persisted history and settles separate lifetimes (restart=%s)', async restart => {
    await assertWorkflowSessionContinuation({ restart })
  }, 120_000)
})
