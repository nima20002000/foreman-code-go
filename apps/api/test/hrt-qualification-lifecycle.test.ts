import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@graphql/contracts'
import type { QualificationSuiteInput } from '../src/modules/harnesses/qualification/types.js'

vi.mock('../src/modules/harnesses/process.js', () => ({ runCommand: vi.fn(async () => ({ exitCode: 0, stdout: 'codex-cli 0.158.0', stderr: '' })) }))
vi.mock('node:fs/promises', async (original) => ({ ...await original<typeof import('node:fs/promises')>(), mkdtemp: vi.fn(async () => '/qualification-owned'), rm: vi.fn(async () => undefined) }))
vi.mock('../src/modules/harnesses/compatibility/probe.js', async (original) => ({ ...await original<typeof import('../src/modules/harnesses/compatibility/probe.js')>(), nativeCompatibilityProbe: vi.fn() }))

import { rm } from 'node:fs/promises'
import { nativeCompatibilityProbe } from '../src/modules/harnesses/compatibility/probe.js'
import { runCommand } from '../src/modules/harnesses/process.js'
import { HarnessQualificationService } from '../src/modules/harnesses/qualification/service.js'

function gate<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function fixture(staticCheck: ConstructorParameters<typeof HarnessQualificationService>[6] = async () => 'schema') {
  const inspectBinary = vi.fn(async () => ({ binary: '/fixture/codex', sha256: 'a'.repeat(64) }))
  const save = vi.fn(async () => undefined)
  const run = vi.fn(async (_input: QualificationSuiteInput) => ({ checks: [{ id: 'live', passed: true, detail: null }], evidence: {} }))
  const audit = vi.fn(async () => undefined)
  const settings = vi.fn(async () => ({ revision: 0, defaults: DEFAULT_HARNESS_DEFAULTS }))
  const service = new HarnessQualificationService({ find: async () => undefined, save } as never,
    { inspectBinary, trusted: async () => true } as never,
    { codex: { harness: 'codex', revision: 'test', run }, opencode: { harness: 'opencode', revision: 'test', run } },
    { codex: '/fixture/codex', opencode: '/fixture/opencode' }, { recordAudit: audit } as never,
    { getManagedHarnessDefaults: settings }, staticCheck)
  return { service, inspectBinary, save, run, audit, settings }
}

afterEach(() => { vi.clearAllMocks(); vi.mocked(rm).mockResolvedValue(undefined) })

describe('qualification stop/cancel/join', () => {
  it('registers preparation before its first await and stops before any version process starts', async () => {
    const f = fixture(), inspecting = gate<Awaited<ReturnType<typeof f.inspectBinary>>>()
    f.inspectBinary.mockReturnValueOnce(inspecting.promise)
    const begin = f.service.begin('codex')
    const rejection = expect(begin).rejects.toMatchObject({ name: 'AbortError' })
    let joined = false
    const shutdown = f.service.shutdown().then(() => { joined = true })
    await Promise.resolve()
    expect(joined).toBe(false)
    inspecting.resolve({ binary: '/fixture/codex', sha256: 'a'.repeat(64) })
    await rejection; await shutdown
    expect(runCommand).not.toHaveBeenCalled()
    await expect(f.service.begin('codex')).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('shares one suite and joins abort handling, final persistence and directory cleanup', async () => {
    const f = fixture(), entered = gate(), cleanup = gate(), finalSave = gate()
    f.run.mockImplementation(async (input) => {
      entered.resolve()
      await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      await cleanup.promise
      throw input.signal.reason
    })
    f.save.mockResolvedValueOnce(undefined).mockImplementationOnce(() => finalSave.promise)
    await f.service.begin('codex'); await entered.promise
    await f.service.begin('codex')
    expect(f.run).toHaveBeenCalledTimes(1)
    const first = f.service.shutdown()
    expect(f.service.shutdown()).toBe(first)
    let joined = false; void first.then(() => { joined = true })
    await Promise.resolve(); expect(joined).toBe(false)
    cleanup.resolve()
    await vi.waitFor(() => expect(f.save).toHaveBeenCalledTimes(2))
    expect(joined).toBe(false); expect(rm).not.toHaveBeenCalled()
    finalSave.resolve(); await first
    expect(rm).toHaveBeenCalledWith('/qualification-owned', { recursive: true, force: true })
    expect(f.run.mock.calls[0]![0].signal.aborted).toBe(true)
  })

  it('does not start a suite after shutdown interrupts saved-default readback', async () => {
    const f = fixture(), saved = gate<Awaited<ReturnType<typeof f.settings>>>()
    f.settings.mockReturnValue(saved.promise)
    await f.service.begin('codex')
    await vi.waitFor(() => expect(f.settings).toHaveBeenCalledTimes(1))
    const stopped = f.service.shutdown()
    saved.resolve({ revision: 0, defaults: DEFAULT_HARNESS_DEFAULTS })
    await stopped
    expect(f.run).not.toHaveBeenCalled(); expect(rm).toHaveBeenCalledTimes(1)
  })

  it('retains failed temporary cleanup and retries it without restarting native work', async () => {
    const f = fixture()
    vi.mocked(rm).mockRejectedValue(new Error('directory busy'))
    await f.service.begin('codex')
    await vi.waitFor(() => expect(rm).toHaveBeenCalledTimes(1))
    await expect(f.service.shutdown()).rejects.toThrow('cleanup was incomplete')
    vi.mocked(rm).mockResolvedValue(undefined)
    await f.service.shutdown()
    expect(f.run).toHaveBeenCalledTimes(1); expect(rm).toHaveBeenCalledTimes(3)
  })

  it('retains a partially acquired diagnostic probe and retries its positive close barrier', async () => {
    const close = vi.fn(async () => { throw new Error('process closure uncertain') })
    const probe = { inspect: vi.fn(async () => { throw new Error('probe failed') }), close }
    vi.mocked(nativeCompatibilityProbe).mockReturnValue(probe as never)
    const f = fixture(undefined)
    // Explicit undefined selects the production static probe rather than a fixture check.
    const service = new HarnessQualificationService({ find: async () => undefined, save: f.save } as never,
      { inspectBinary: f.inspectBinary } as never,
      { codex: { harness: 'codex', revision: 'test', run: f.run }, opencode: { harness: 'opencode', revision: 'test', run: f.run } },
      { codex: '/fixture/codex', opencode: '/fixture/opencode' }, {} as never, { getManagedHarnessDefaults: f.settings })
    await service.begin('codex')
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1))
    await expect(service.shutdown()).rejects.toThrow('cleanup was incomplete')
    close.mockResolvedValueOnce(undefined)
    await service.shutdown()
    expect(close).toHaveBeenCalledTimes(3); expect(f.run).not.toHaveBeenCalled()
  })

  it('retries registered native cleanup before removing its project and never repeats the suite', async () => {
    const f = fixture(), close = vi.fn(async () => { throw new Error('cgroup nonempty') })
    f.run.mockImplementation(async (input) => {
      input.ownCleanup?.(close)
      throw new AggregateError([new Error('partial acquisition')], 'Native cleanup failed')
    })
    await f.service.begin('codex')
    await vi.waitFor(() => expect(f.save).toHaveBeenCalledTimes(2))
    await expect(f.service.shutdown()).rejects.toThrow('cleanup was incomplete')
    expect(rm).not.toHaveBeenCalled()
    close.mockResolvedValueOnce(undefined)
    await f.service.shutdown()
    expect(f.run).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalledTimes(2)
    expect(rm).toHaveBeenCalledTimes(1)
  })

  it('keeps unconfirmed suite cleanup visible instead of using a finished Promise as proof', async () => {
    const f = fixture()
    f.run.mockRejectedValue(new AggregateError([new Error('descendant alive')], 'Native closure unconfirmed'))
    await f.service.begin('codex')
    await vi.waitFor(() => expect(f.save).toHaveBeenCalledTimes(2))
    await expect(f.service.shutdown()).rejects.toThrow('cleanup was incomplete')
    await expect(f.service.shutdown()).rejects.toThrow('cleanup was incomplete')
    expect(rm).not.toHaveBeenCalled()
  })
})
