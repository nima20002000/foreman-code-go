import { expect, it } from 'vitest'
import { pairedWorkerApplication } from './helpers/pairedWorkerApplication.js'

it('connects the committed installed Worker to the production Main through the normal pairing path', async () => {
  const fixture = await pairedWorkerApplication()
  try {
    expect(fixture.inventory.hostMetadata?.hostRef).toEqual(fixture.hostRef)
    expect(fixture.inventory.hostMetadata?.connection?.binding.workerInstallationId)
      .toBe(fixture.roots.applicationInstallationId)
    expect(fixture.inventory.installations.filter(value => value.installed).map(value => value.driverId))
      .toEqual(expect.arrayContaining(['codex', 'opencode', 'claude']))
    const devices = await fixture.tool('devices_list', {}) as { devices: Array<{ deviceId: string; status: string }> }
    expect(devices.devices.find(value => value.deviceId === fixture.hostRef.deviceId)?.status).toBe('paired')
  } finally { await fixture.close() }
}, 300000)
