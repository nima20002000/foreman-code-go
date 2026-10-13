import { describe, expect, it } from 'vitest'
import { installationUpdateFixture } from './helpers/harnessInstallationUpdate.js'
import { assertInstalledWorkflowRestart } from './helpers/installedWorkflowRestart.js'

describe('installed Main-local workflows across systemd restart', () => {
  it('starts an installed API on a fresh user service setup', async () => {
    const fixture = await installationUpdateFixture({
      workflow: 'single', executionHost: 'main', installedMainService: true,
    })
    try {
      expect(await fixture.mainService!.state()).toBe('active')
      const pid = await fixture.mainService!.pid()
      expect(pid).toBeGreaterThan(0)
      expect(() => process.kill(pid, 0)).not.toThrow()
      const health = await fetch(new URL('/health/live', fixture.origin()))
      expect(health.status).toBe(200)
    } finally {
      await fixture.close()
    }
  }, 600_000)

  it('reattaches graph work and its active check, then closes their processes', async () => {
    await assertInstalledWorkflowRestart('active')
  }, 600_000)
})
