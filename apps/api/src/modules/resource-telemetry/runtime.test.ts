import { describe, expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import { telemetryComputerFixture, telemetryOwnedFixture } from '@graphql/contracts/resource-telemetry-fixtures'
import { TelemetryReadResultSchema, telemetrySelectorKey, type TelemetrySelector, type TelemetrySelectorTarget, type TrustedTelemetryContext } from '@graphql/contracts/resource-telemetry'
import type { TelemetryOwnedTargetFacts } from './readback/selector.js'
import { createResourceCollector } from './collector/lifecycle.js'
import { createResourceTelemetryRuntime, type ResourceTelemetryRuntimeInput } from './runtime.js'
const principal: ManagementPrincipal = { id: 'operator', name: 'Reader', audience: 'operator', grants: [], expiresAt: '2099-01-01T00:00:00Z', revokedAt: null }
const target: TelemetrySelectorTarget = { schemaVersion: 1, scope: 'computer', mainId: telemetryComputerFixture.mainId, hostRef: telemetryComputerFixture.host.hostRef }
function setup() {
  let mono = 0, active = true
  const h = telemetryComputerFixture.host
  const context: Extract<TrustedTelemetryContext, { kind: 'main-local' }> = { kind: 'main-local', mainId: telemetryComputerFixture.mainId,
    deviceId: telemetryComputerFixture.mainId, applicationInstallationId: h.applicationInstallationId, bootId: h.bootId, runtimeEpoch: h.runtimeEpoch, capability: 'resource-telemetry/v1' }
  const controller = new AbortController()
  const read = vi.fn(async (path: string) => path.includes('boot_id') ? h.bootId : path.includes('online') ? '0-7'
    : path.includes('meminfo') ? 'MemTotal: 8 kB\nMemAvailable: 4 kB' : 'cpu 1 0 0 10 0 0 0 0')
  let owned: Extract<TelemetrySelector, { scope: 'owned' }> = structuredClone(telemetryOwnedFixture)
  const snapshot = vi.fn(() => ({ revision: '1', launches: [{ owner: 'accepted-owner-1', launchId: 'launch-1', bootId: h.bootId,
    provider: { pid: 123, startTicks: '12' }, lifecycle: 'active' as const }] }))
  const stat = vi.fn(async (pid: number) => {
    const fields = Array<string>(23).fill('0')
    fields[0] = 'R'; fields[1] = '1'; fields[11] = '100'; fields[19] = '12'; fields[21] = '1'
    return `${pid} (captured-provider) ${fields.join(' ')}`
  })
  const input: ResourceTelemetryRuntimeInput = { localContext: context, signal: controller.signal,
    clock: { monotonicMs: () => mono, unixMs: () => 1_000_000 + Math.floor(mono) },
    sessions: { active: async () => active, presence: async () => 'online' },
    ownership: { resolve: async selector => telemetrySelectorKey(selector) === telemetrySelectorKey(owned)
      ? { selector: owned, state: 'active', sharedOwners: [] } : null },
    reads: { allow: async p => p.id === principal.id, allowSharedOwner: async () => false },
    targets: { allowTarget: async p => p.id === principal.id, resolveOwned: async () => {
      const host: TelemetryOwnedTargetFacts['host'] = { ...owned.host }
      Reflect.deleteProperty(host, 'collectorGeneration')
      return { kind: 'owned', facts: { owner: owned.owner, host, attributionRef: owned.attributionRef, attributionRevision: owned.attributionRevision } }
    } },
    registry: { snapshot, revision: () => '1', changes: async function* () {} },
    nativeScopes: identity => {
      owned = { ...owned, host: identity.host }
      return { revision: () => '1', snapshot: async () => [{ selector: owned, leaseId: owned.attributionRef, nativeOwner: 'accepted-owner-1',
        observedDeviceId: identity.host.deviceId, observedInstallationId: identity.host.applicationInstallationId, shared: false, lifecycle: 'active' }],
        changes: async function* () {} }
    },
    wholeHostVisible: true,
    createCollector: async options => createResourceCollector({ identity: options.identity,
      clock: { now: () => 1_000_000n + BigInt(Math.floor(mono * 1_000_000)), wall: input.clock!.unixMs, setTimer: setTimeout, clearTimer: clearTimeout },
      ports: { read, now: () => 1_000_000n + BigInt(Math.floor(mono * 1_000_000)), ownership: options.ownership,
        wholeHostVisible: options.wholeHostVisible, constants: { clockTicksPerSecond: 100n, pageSize: 4096n },
        process: { stat, children: async () => [] } } }),
  }
  return { input, controller, read, snapshot, stat, getOwned: () => structuredClone(owned), advance(ms: number) { mono += ms }, active(value: boolean) { active = value } }
}
describe('passive telemetry runtime composition', () => {
  it('handshakes actual identity, exposes a selector before sample, and pumps the real collector into shared readback', async () => {
    vi.useFakeTimers()
    const s = setup(), runtime = await createResourceTelemetryRuntime(s.input)
    try {
      const discovered = await runtime.selectors.resolve(principal, target, new AbortController().signal)
      expect(discovered.kind).toBe('selector')
      if (discovered.kind !== 'selector') throw new Error('selector')
      expect(discovered.selector.host.collectorGeneration).toBe(runtime.identity.host.collectorGeneration)
      expect(runtime.identity.host.collectorGeneration).not.toBe(telemetryComputerFixture.host.collectorGeneration)
      expect((await runtime.service.read(principal, discovered.selector, new AbortController().signal)).kind).toBe('no-sample')
      s.advance(0.25); await vi.advanceTimersByTimeAsync(1)
      const first = TelemetryReadResultSchema.parse(await runtime.service.read(principal, discovered.selector, new AbortController().signal))
      expect(first.kind).toBe('sample')
      if (first.kind !== 'sample') throw new Error('sample')
      expect(first.sample.identity).toEqual(runtime.identity)
      expect(first.sample.cpu.state).toBe('warmup')
      expect(first.sample.memory.state).toBe('fresh')
      expect(first.sample.memory.value?.bytes).toBe(4096)
      expect(first.sample.ageUpperBoundMs).toBe(0.25)
      s.advance(2000); await vi.advanceTimersByTimeAsync(2000)
      const second = TelemetryReadResultSchema.parse(await runtime.service.read(principal, discovered.selector, new AbortController().signal))
      expect(second.kind === 'sample' && second.sample.sequence).toBe('2')
      expect(s.read).toHaveBeenCalled(); expect(s.snapshot).toHaveBeenCalled(); expect(s.stat).toHaveBeenCalledWith(123, expect.any(AbortSignal))
      const owned = TelemetryReadResultSchema.parse(await runtime.service.read(principal, s.getOwned(), new AbortController().signal))
      expect(owned.kind === 'sample' && owned.sample.memory.value?.bytes).toBe(4096)
      expect(owned.kind === 'sample' && owned.sample.memory.state).toBe('fresh')
      expect(owned.kind === 'sample' && owned.sample.cpu.state).toBe('fresh')
      const identity = runtime.identity; identity.host.collectorGeneration = 'mutated'
      expect(runtime.identity.host.collectorGeneration).not.toBe('mutated')
    } finally { await runtime.close(); vi.useRealTimers() }
    expect(await runtime.completion).toEqual({ kind: 'closed' })
  })
  it('fails closed when the real session authority is lost and joins collector/timers', async () => {
    vi.useFakeTimers()
    const s = setup(), runtime = await createResourceTelemetryRuntime(s.input)
    try {
      await vi.advanceTimersByTimeAsync(1); s.active(false); s.advance(2000)
      await vi.advanceTimersByTimeAsync(2000)
      const outcome = await runtime.completion
      expect(outcome.kind).toBe('failed')
      await expect(runtime.close()).rejects.toThrow('authorization')
      expect(vi.getTimerCount()).toBe(0)
      expect(await runtime.selectors.resolve(principal, target, new AbortController().signal)).toEqual({ kind: 'unavailable' })
    } finally { vi.useRealTimers() }
  })
  it('rejects an invented local device identity before constructing a collector', async () => {
    const s = setup()
    s.input.localContext.deviceId = telemetryComputerFixture.host.deviceId
    await expect(createResourceTelemetryRuntime(s.input)).rejects.toThrow('canonical main identity')
    expect(s.read).not.toHaveBeenCalled(); expect(s.snapshot).not.toHaveBeenCalled()
  })
  it('closes a constructed collector when startup is aborted before pumps begin', async () => {
    const s = setup(), close = vi.fn(async () => {})
    s.input.createCollector = async () => {
      s.controller.abort()
      return { offer: () => 'accepted', samples: async function* () {}, close }
    }
    await expect(createResourceTelemetryRuntime(s.input)).rejects.toThrow()
    expect(close).toHaveBeenCalledOnce()
  })
})
