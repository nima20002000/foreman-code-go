import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { installationUpdateFixture } from './helpers/harnessInstallationUpdate.js'
import { assertInstalledWorkflowRestart } from './helpers/installedWorkflowRestart.js'

describe('installed Main-local workflows across systemd restart', () => {
  let fixture: Awaited<ReturnType<typeof installationUpdateFixture>> | undefined

  beforeAll(async () => {
    fixture = await installationUpdateFixture({
      workflow: 'interval', executionHost: 'main', installedMainService: true,
    })
  }, 600_000)

  afterAll(async () => { await fixture?.close() }, 600_000)

  it('starts an installed API on a fresh user service setup', async () => {
    expect(await fixture!.mainService!.state()).toBe('active')
    const pid = await fixture!.mainService!.pid()
    expect(pid).toBeGreaterThan(0)
    expect(() => process.kill(pid, 0)).not.toThrow()
    const health = await fetch(new URL('/health/live', fixture!.origin()))
    expect(health.status).toBe(200)
  })

  it('reattaches graph work and its active check, then closes their processes', async () => {
    await assertInstalledWorkflowRestart('active', fixture!)
  }, 600_000)
})
