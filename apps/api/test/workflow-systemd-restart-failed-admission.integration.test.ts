import { RuntimeBuildIdentitySchema } from '@foreman-code/contracts'
import { describe, expect, it } from 'vitest'
import { installationUpdateFixture } from './helpers/harnessInstallationUpdate.js'
import { assertInstalledWorkflowRestart } from './helpers/installedWorkflowRestart.js'

describe('installed Main-local workflows across systemd restart', () => {
  it('closes interrupted processes when interval admission fails during restart', async () => {
    const fixture = await installationUpdateFixture({ workflow: 'interval', executionHost: 'main',
      installedMainService: true, sourceAccessMode: 'read-only' })
    try {
      const response = await fetch(new URL('/api/runtime/build-identity/v1', fixture.origin()))
      expect(response.status).toBe(200)
      expect(RuntimeBuildIdentitySchema.safeParse(await response.json()).success).toBe(true)
      await assertInstalledWorkflowRestart('failed admission', fixture)
    } finally {
      await fixture.close()
    }
  }, 600_000)
})
