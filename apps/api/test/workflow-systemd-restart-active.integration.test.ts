import { describe, it } from 'vitest'
import { assertInstalledWorkflowRestart } from './helpers/installedWorkflowRestart.js'

describe('installed Main-local workflows across systemd restart', () => {
  it('reattaches graph work and its active check, then closes their processes', async () => {
    await assertInstalledWorkflowRestart('active')
  }, 600_000)
})
