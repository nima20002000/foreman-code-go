import { afterEach, expect, it, vi } from 'vitest'
import { ComputerMaintenance, systemMaintenancePorts } from './maintenance.js'
import { MainCodexSelection } from './installedCodexSelection.js'
import type { MaintenancePorts } from './maintenancePorts.js'
import * as fs from 'node:fs/promises'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof fs>(),
  readdir: vi.fn(), access: vi.fn(), statfs: vi.fn(),
}))
afterEach(() => vi.restoreAllMocks())

function ports(): MaintenancePorts {
  return { environment: { HOME: '/fixture' }, find: async name => name, readText: async () => null,
    writePrivateText: async () => undefined, exists: async () => false, disk: async () => null,
    later: () => undefined, now: () => new Date(), run: async () => ({ code: 0, stdout: '1.2.3', stderr: '' }) }
}

it('preserves installation discovery permission failures', async () => {
  const failure = Object.assign(new Error('Installation inaccessible'), { code: 'EACCES' })
  vi.mocked(fs.readdir).mockRejectedValue(failure)
  const selection = new MainCodexSelection('codex', '/fixture/selection', ports())
  await expect(selection.selectInstalled(new AbortController().signal)).rejects.toBe(failure)
})

it.each(['version', 'latest', 'packages', 'sudo'])('reports a failed %s inspection instead of a clean unknown', async area => {
  const host = ports()
  host.run = async (binary, args) => {
    const failed = area === 'version' && args[0] === '--version'
      || area === 'latest' && binary === 'npm'
      || area === 'packages' && binary === 'apt-get'
      || area === 'sudo' && binary === 'sudo'
    return { code: failed ? 2 : 0,
      stdout: binary === 'apt-get' ? '0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.' : '1.2.3', stderr: '' }
  }
  const maintenance = new ComputerMaintenance(host)
  await expect(maintenance.status(new AbortController().signal)).rejects.toThrow(/inspection|version|updates|sudo/i)
})

it('does not turn unreadable reboot and disk facts into absence', async () => {
  const failure = Object.assign(new Error('Storage inaccessible'), { code: 'EACCES' })
  vi.mocked(fs.access).mockRejectedValue(failure)
  vi.mocked(fs.statfs).mockRejectedValue(failure)
  const host = systemMaintenancePorts({ HOME: '/fixture', PATH: '' })
  await expect(host.exists('/fixture/reboot-required')).rejects.toBe(failure)
  await expect(host.disk('/fixture')).rejects.toBe(failure)
})
