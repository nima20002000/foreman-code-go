import { expect, it, vi } from 'vitest'
import type { CanonicalMachineReference } from '@foreman-code/contracts/device-identity'
import { HarnessInstallationMonitor } from './installationMonitor.js'
import type { AutomaticHostProfileCheck } from './instanceSettings/profileChecks.js'

it('detects a new payload at the same launcher and schedules one automatic check per inventory generation', async () => {
  const hostRef = { kind: 'main' as const, mainId: 'main' }
  let fingerprint = 'old-payload'
  let listener: ((host: CanonicalMachineReference, installationId: string) => void) | undefined
  const recheckInstallation = vi.fn<(input: AutomaticHostProfileCheck) => Promise<void>>(async () => {})
  const registry = {
    observeInstallations: (value: typeof listener) => { listener = value },
    installations: { list: () => [{ hostRef, harnessInstallationId: 'same-launcher',
      installationFingerprint: fingerprint, driverId: 'codex', driverRevision: '1',
      protocolRevision: 'protocol', environmentGeneration: 'environment', connectionGeneration: 'connection', installed: true }] },
    refreshMain: async () => { listener?.(hostRef, 'main') },
  }
  const report = vi.fn()
  const monitor = new HarnessInstallationMonitor(registry as never, { recheckInstallation } as never,
    () => ({} as never), async () => {}, async () => {}, report, 100)
  vi.useFakeTimers()
  try {
    monitor.start('main')
    expect(recheckInstallation).toHaveBeenCalledTimes(1)
    await monitor.refresh()
    expect(recheckInstallation).toHaveBeenCalledTimes(1)
    fingerprint = 'updated-payload'
    await vi.advanceTimersByTimeAsync(100)
    expect(recheckInstallation).toHaveBeenCalledTimes(2)
    const first = recheckInstallation.mock.calls[0]![0]
    const updated = recheckInstallation.mock.calls[1]![0]
    expect(updated.generation).not.toBe(first.generation)
    expect(updated.host).toEqual(hostRef)
    expect(updated.driverId).toBe('codex')
    expect(updated.applicationInstallationId).toBe('main')
    await monitor.refresh()
    expect(recheckInstallation).toHaveBeenCalledTimes(2)
    expect(report).not.toHaveBeenCalled()
  } finally {
    await monitor.close()
    vi.useRealTimers()
  }
  expect(listener).toBeUndefined()
})

it('schedules only the changed driver when Claude updates beside an unchanged Codex installation', async () => {
  const hostRef = { kind: 'main' as const, mainId: 'main' }
  let listener: ((host: CanonicalMachineReference, installationId: string) => void) | undefined
  const fingerprints = { codex: 'codex-original', claude: 'claude-original' }
  const recheckInstallation = vi.fn<(input: AutomaticHostProfileCheck) => Promise<void>>(async () => {})
  const registry = {
    observeInstallations: (value: typeof listener) => { listener = value },
    installations: { list: () => Object.entries(fingerprints).map(([driverId, installationFingerprint]) => ({
      hostRef, driverId, installationFingerprint, harnessInstallationId: driverId, driverRevision: '1',
      protocolRevision: 'protocol', environmentGeneration: 'environment', connectionGeneration: 'connection',
      installed: true,
    })) },
    refreshMain: async () => { listener?.(hostRef, 'main') },
  }
  const monitor = new HarnessInstallationMonitor(registry as never, { recheckInstallation } as never,
    () => ({} as never), async () => {}, async () => {}, vi.fn())
  try {
    monitor.start('main')
    expect(recheckInstallation.mock.calls.map(([input]) => input.driverId)).toEqual(['codex', 'claude'])
    recheckInstallation.mockClear()
    fingerprints.claude = 'claude-updated'
    await monitor.refresh()
    expect(recheckInstallation).toHaveBeenCalledTimes(1)
    expect(recheckInstallation.mock.calls[0]![0]).toMatchObject({ driverId: 'claude' })
    expect(recheckInstallation.mock.calls[0]![0].beforeChecks).toBeUndefined()
  } finally { await monitor.close() }
})

it('refreshes Main independently of a slow unused Worker and cancels only a required-host caller wait', async () => {
  const main = { kind: 'main' as const, mainId: 'main' }
  const worker = { kind: 'device' as const, mainId: 'main', deviceId: 'worker' }
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  let entered!: () => void
  const discovering = new Promise<void>(resolve => { entered = resolve })
  let discoverySignal: AbortSignal | undefined
  const request = vi.fn(async (_input: unknown, options: { signal: AbortSignal }) => {
    discoverySignal = options.signal
    entered()
    await waiting
    return { payload: { discovered: true } }
  })
  const refreshMain = vi.fn(async () => {})
  const collectWorker = vi.fn(async () => {})
  const registry = { installations: { list: () => [{ hostRef: main }, { hostRef: worker }] },
    refreshMain, observeInstallations: () => {} }
  const monitor = new HarnessInstallationMonitor(registry as never, {} as never,
    () => ({ captureRequest: () => ({ binding: {}, request }) }) as never,
    collectWorker, async () => {}, vi.fn())
  const background = monitor.refresh()
  try {
    await discovering
    await monitor.refreshHosts([main])
    expect(refreshMain).toHaveBeenCalled()
    expect(collectWorker).not.toHaveBeenCalled()
    const canceled = new AbortController()
    const start = monitor.refreshHosts([worker], canceled.signal)
    const failure = new Error('Start canceled')
    canceled.abort(failure)
    await expect(start).rejects.toBe(failure)
    expect(discoverySignal!.aborted).toBe(false)
    expect(request).toHaveBeenCalledTimes(1)
    release()
    await background
    expect(collectWorker).toHaveBeenCalledTimes(1)
  } finally {
    release()
    await background
    await monitor.close()
  }
})
