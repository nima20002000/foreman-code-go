import { describe, it } from 'vitest'
import { assertInstalledWorkflowRestart } from './helpers/installedWorkflowRestart.js'

describe('installed Main-local workflows across systemd restart', () => {
  it('closes interrupted processes when interval admission fails during restart', async () => {
    await assertInstalledWorkflowRestart('failed admission')
  }, 600_000)
})
