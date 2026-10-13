import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RuntimeBuildIdentitySchema } from '@foreman-code/contracts'
import { createRuntimeBuildIdentity } from '@foreman-code/contracts/runtime-build-identity-node'
import { fileURLToPath } from 'node:url'
import { installationUpdateFixture } from './helpers/harnessInstallationUpdate.js'
import { assertInstalledWorkflowRestart } from './helpers/installedWorkflowRestart.js'

describe('installed Main-local workflows across systemd restart', () => {
  let fixture: Awaited<ReturnType<typeof installationUpdateFixture>> | undefined
  const repository = fileURLToPath(new URL('../../../', import.meta.url))
  const readBuildIdentity = () => fetch(new URL('/api/runtime/build-identity/v1', fixture!.origin()), {
    headers: { authorization: `Bearer ${fixture!.writer.token}` },
  })

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

  it('rejects an invalid credential when reading the packaged build identity', async () => {
    const response = await fetch(new URL('/api/runtime/build-identity/v1', fixture!.origin()), {
      headers: { authorization: 'Bearer invalid-fixture-credential' },
    })
    expect(response.status).toBe(401)
  })

  it('serves its packaged build identity without requiring a source checkout', async () => {
    const response = await readBuildIdentity()
    expect(response.status).toBe(200)
    const identity = RuntimeBuildIdentitySchema.parse(await response.json())
    expect(identity).toEqual(createRuntimeBuildIdentity(repository))
  })

  it('reattaches graph work and its active check, then closes their processes', async () => {
    await assertInstalledWorkflowRestart('active', fixture!)
  }, 600_000)

  it('serves the packaged build identity after workflow recovery', async () => {
    const response = await readBuildIdentity()
    expect(response.status).toBe(200)
    const identity = RuntimeBuildIdentitySchema.parse(await response.json())
    expect(identity).toEqual(createRuntimeBuildIdentity(repository))
  })
})
