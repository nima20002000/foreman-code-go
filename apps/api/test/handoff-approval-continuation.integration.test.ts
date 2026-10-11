import { afterEach, describe, it, vi } from 'vitest'
import { runHandoffApproval } from './helpers/handoffApproval.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

afterEach(() => vi.restoreAllMocks())

describe.skipIf(!postgresEnabled)('handoff Worker approval through the designated Orchestrator', () => {
  it('resumes each business activation with persisted reviewer ownership (restart=false)', async () => {
    await runHandoffApproval({ restart: false })
  }, 120000)
})
