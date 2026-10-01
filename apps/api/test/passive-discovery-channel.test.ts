import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as childProcess from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { harnessConnectionGeneration } from '../src/modules/harnesses/hostConnectionGeneration.js'
import { createPassiveHarnessDiscoveryExtension } from '../src/modules/harnesses/passiveDiscoveryChannel.js'

vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return { ...original, spawn: vi.fn(original.spawn) }
})
const directories: string[] = []
afterEach(async () => { vi.clearAllMocks(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const mainId = '00000000-0000-4000-8000-000000000001'
const deviceId = '00000000-0000-4000-8000-000000000002'
const workerInstallationId = '00000000-0000-4000-8000-000000000003'
const binding = { mainId, deviceId, workerInstallationId, bootId: '00000000-0000-4000-8000-000000000004', keyRevision: 1, authorizationRevision: 1, connectionEpoch: 'current-epoch', connectionGeneration: 2 }
const payload = { operation: 'discover', refreshId: '00000000-0000-4000-8000-000000000005' }
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'hrt-channel-')); directories.push(directory)
  const launcher = join(directory, 'fixed launcher')
  await writeFile(launcher, '#!/bin/sh\nexit 0\n'); await chmod(launcher, 0o755)
  return createPassiveHarnessDiscoveryExtension({ hostRef: { kind: 'device', mainId, deviceId }, applicationInstallationId: workerInstallationId,
    platform: { platform: 'linux', architecture: 'x64' }, environment: { generation: 'worker-env', provenance: 'worker', cwd: directory, path: '/usr/bin:/bin' },
    installations: [{ driverId: 'fixed', driverRevision: '1', protocolRevision: '1', harnessInstallationId: 'fixed-install', requestedLauncher: launcher },
      { driverId: 'missing', driverRevision: '1', protocolRevision: '1', harnessInstallationId: 'missing-install', requestedLauncher: join(directory, 'absent') }] })
}
describe('negotiated passive discovery worker handler', () => {
  it('collects only trusted declarations and reports unavailable inventory without native probes', async () => {
    const extension = await fixture()
    expect(extension).toMatchObject({ namespace: 'harness-discovery-v1', role: 'server', maxBinaryBytes: 0 })
    const result = (await extension.handle(payload, { binding, signal: new AbortController().signal })).payload
    expect(result.installations).toHaveLength(2)
    expect(result.installations[0]).toMatchObject({ installed: true, authenticated: null, compatible: null, qualified: null, observedVersion: null, connectionGeneration: harnessConnectionGeneration(binding) })
    expect(result.installations[1]).toMatchObject({ installed: false, installationFingerprint: null, launcher: { status: 'missing' } })
    expect(result.hostMetadata).toMatchObject({ hostRef: { kind: 'device', mainId, deviceId }, applicationInstallationId: workerInstallationId, connection: null, workspaceRoots: null })
    expect(childProcess.spawn).not.toHaveBeenCalled()
  })
  it('rejects caller commands/paths and wrong canonical identities, with no local fallback', async () => {
    const extension = await fixture(), signal = new AbortController().signal
    await expect(extension.handle({ ...payload, requestedLauncher: '/untrusted' }, { binding, signal })).rejects.toThrow()
    for (const field of ['mainId', 'deviceId', 'workerInstallationId'] as const) await expect(extension.handle(payload, { binding: { ...binding, [field]: 'other' }, signal })).rejects.toThrow('binding mismatch')
    expect(childProcess.spawn).not.toHaveBeenCalled()
  })
  it('fences every canonical binding component despite a repeated numeric connection counter', () => {
    const current = harnessConnectionGeneration(binding)
    for (const key of Object.keys(binding) as (keyof typeof binding)[]) {
      const changed = { ...binding, [key]: typeof binding[key] === 'number' ? 9 : 'different' }
      expect(harnessConnectionGeneration(changed)).not.toBe(current)
    }
  })
  it('honors an aborted admitted connection before reading files', async () => {
    const extension = await fixture(), controller = new AbortController()
    controller.abort(new Error('connection replaced'))
    await expect(extension.handle(payload, { binding, signal: controller.signal })).rejects.toThrow('connection replaced')
    expect(childProcess.spawn).not.toHaveBeenCalled()
  })
})
