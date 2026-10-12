import { describe, it } from 'vitest'
import { assertInstalledWorkflowRestart } from './helpers/installedWorkflowRestart.js'

describe('installed Main-local workflows across systemd restart', () => {
  it('reattaches graph work and its admitting interval check, then closes their processes', async () => {
    await assertInstalledWorkflowRestart('admitting interval')
  }, 600_000)
})
