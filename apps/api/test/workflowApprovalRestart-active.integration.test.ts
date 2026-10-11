import { describe, it } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { assertJoinCheckpointRestart, restartCleanup } from './workflowApprovalRestart.test-support.js'

const closes = restartCleanup()

describe.skipIf(!postgresEnabled)('pending workflow approval restart', () => {
  it.each([true])('restores the original join checkpoint through a recomposed engine (active invocation: %s)', async (activeInvocation) => {
    await assertJoinCheckpointRestart({ activeInvocation, closes })
  }, 90000)
})
