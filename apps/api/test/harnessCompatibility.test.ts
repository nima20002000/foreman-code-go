import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CompatibilityHarness } from '@graphql/contracts'
import { HarnessCompatibilityService, compatibilityCacheKey } from '../src/modules/harnesses/compatibility/service.js'
import type { CompatibilityCache, CompatibilityCacheEntry } from '../src/modules/harnesses/compatibility/cache.js'
import type { CompatibilityProbe, HarnessInstallation } from '../src/modules/harnesses/compatibility/probe.js'
import { CompatibilityCheckError } from '../src/modules/harnesses/compatibility/errors.js'
import { COMPATIBILITY_CHECKER_REVISION, QUALIFIED_RELEASES } from '../src/modules/harnesses/compatibility/releases.js'
import { QUALIFIED_CODEX_VERSION } from '../src/modules/harnesses/codexProtocol.js'

const now = Date.parse('2026-09-19T12:00:00.000Z')
const sha = 'a'.repeat(64)
class MemoryCache implements CompatibilityCache {
  entries = new Map<CompatibilityHarness, CompatibilityCacheEntry>()
  async load(harness: CompatibilityHarness, key: string, at: number) {
    const entry = this.entries.get(harness)
    return entry?.key === key && Date.parse(entry.expiresAt) > at ? entry : null
  }
  async save(entry: CompatibilityCacheEntry) { this.entries.set(entry.harness, entry) }
}
function fixture(codexVersion = '99.0.0') {
  const installation = (harness: CompatibilityHarness): HarnessInstallation => ({
    executable: `/fake/${harness}`, identity: `${harness}-identity`,
    version: harness === 'codex' ? codexVersion : QUALIFIED_RELEASES.opencode.version,
  })
  const probe: CompatibilityProbe = {
    inspect: vi.fn(async (harness) => installation(harness)),
    probe: vi.fn(async () => sha),
    assertUnchanged: vi.fn(async () => undefined),
  }
  return { probe, cache: new MemoryCache(), now: () => now }
}
const services: HarnessCompatibilityService[] = []
function create(options: ConstructorParameters<typeof HarnessCompatibilityService>[0]) {
  const service = new HarnessCompatibilityService(options); services.push(service); return service
}
afterEach(async () => { await Promise.allSettled(services.splice(0).map((service) => service.close())) })

describe('harness compatibility diagnostics (not execution qualification)', () => {
  it('records official provenance for the bundled native qualification versions', async () => {
    expect(`codex-cli ${QUALIFIED_RELEASES.codex.version}`).toBe(QUALIFIED_CODEX_VERSION)
    const options = fixture(QUALIFIED_RELEASES.codex.version)
    const result = await create(options).checkAll()
    expect(result.map((row) => row.status)).toEqual(['known-compatible', 'known-compatible'])
    expect(result[0]?.knownRelease?.releaseUrl).toBe('https://github.com/openai/codex/releases/tag/rust-v0.154.0')
    expect(options.probe.probe).not.toHaveBeenCalled()
    expect(options.probe.inspect).toHaveBeenCalledTimes(2)
  })
  it('recognizes the separately qualified Codex 0.156.1 release', async () => {
    const options = fixture('0.156.1')
    const result = await create(options).checkAll()
    expect(result[0]).toMatchObject({ status: 'known-compatible', matchesQualifiedVersion: true,
      qualifiedRelease: { version: '0.156.1' }, knownRelease: { tag: 'rust-v0.156.1' } })
    expect(options.probe.probe).not.toHaveBeenCalled()
  })
  it('caches an unknown version without qualifying it or changing the release manifest', async () => {
    const options = fixture()
    const first = await create(options).checkAll()
    expect(first[0]).toMatchObject({ status: 'probe-passed', installedVersion: '99.0.0', matchesQualifiedVersion: false, knownRelease: null, schemaSha256: sha })
    const second = await create(options).checkAll()
    expect(second[0]).toMatchObject({ status: 'probe-passed', source: 'cache', checkedAt: first[0]?.checkedAt, matchesQualifiedVersion: false })
    expect(options.probe.probe).toHaveBeenCalledTimes(1)
    expect(QUALIFIED_RELEASES.codex.version).toBe('0.154.0')
  })
  it('persists a safe failure reason briefly and reruns it on an explicit retry', async () => {
    const options = fixture()
    vi.mocked(options.probe.probe).mockRejectedValueOnce(new CompatibilityCheckError('PROTOCOL_SETTINGS_UNSUPPORTED', 'Settings schema is unsupported.'))
    const service = create(options)
    expect((await service.checkAll())[0]).toMatchObject({ status: 'probe-failed', reason: { code: 'PROTOCOL_SETTINGS_UNSUPPORTED' } })
    const entry = options.cache.entries.get('codex')!
    expect(Date.parse(entry.expiresAt) - Date.parse(entry.checkedAt)).toBe(60_000)
    expect((await create(options).checkAll())[0]?.source).toBe('cache')
    expect(service.retry('codex').status).toBe('checking')
    await service.checkAll()
    expect(service.get('codex').status).toBe('probe-passed')
    expect(options.probe.probe).toHaveBeenCalledTimes(2)
  })
  it('invalidates reuse on executable replacement and checker revision changes', async () => {
    const options = fixture()
    await create(options).checkAll()
    vi.mocked(options.probe.inspect).mockImplementation(async (harness) => ({
      executable: `/fake/${harness}`, identity: 'replacement',
      version: harness === 'codex' ? '99.0.0' : QUALIFIED_RELEASES.opencode.version,
    }))
    await create(options).checkAll()
    await create({ ...options, checkerRevision: 'next-review' }).checkAll()
    expect(options.probe.probe).toHaveBeenCalledTimes(3)
    const installed = { executable: '/fake/codex', identity: 'one', version: '99.0.0' }
    expect(compatibilityCacheKey('codex', installed, COMPATIBILITY_CHECKER_REVISION))
      .not.toBe(compatibilityCacheKey('codex', { ...installed, version: '99.0.1' }, COMPATIBILITY_CHECKER_REVISION))
  })
  it('coalesces startup and concurrent retries and exposes checking immediately', async () => {
    const options = fixture()
    let finish: (value: string) => void = () => undefined
    vi.mocked(options.probe.probe).mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const service = create(options)
    const first = service.retry('codex')
    expect(first.status).toBe('checking')
    expect(service.retry('codex').checkId).toBe(first.checkId)
    const completed = service.checkAll()
    await vi.waitFor(() => expect(options.probe.probe).toHaveBeenCalledTimes(1))
    finish(sha)
    await completed
    expect(service.get('codex').checkId).toBe(first.checkId)
  })
  it('reports cache corruption/write failures but still returns the fresh result', async () => {
    const options = fixture()
    const cache = { load: vi.fn(async () => { throw new Error('corrupt') }), save: vi.fn(async () => { throw new Error('read only') }) }
    const result = await create({ ...options, cache }).checkAll()
    expect(result[0]).toMatchObject({ status: 'probe-passed', source: 'local-probe' })
    expect(result[0]?.cacheWarning).toContain('could not be read or saved')
  })
  it('does not leak raw native errors or substitute a missing harness', async () => {
    const options = fixture()
    vi.mocked(options.probe.inspect).mockRejectedValue(new Error('secret-token /private/path'))
    const result = await create(options).checkAll()
    expect(result.every((row) => row.status === 'unavailable' && row.installedVersion === null)).toBe(true)
    expect(JSON.stringify(result)).not.toContain('secret-token')
    expect(options.probe.probe).not.toHaveBeenCalled()
  })
  it('retries a timed-out probe with a fresh deadline and caches only the success', async () => {
    const options = fixture()
    vi.mocked(options.probe.probe).mockImplementationOnce((_harness, _installation, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }))
    const result = await create({ ...options, timeoutMs: 20 }).checkAll()
    expect(result[0]).toMatchObject({ status: 'probe-passed', reason: null, schemaSha256: sha })
    expect(options.probe.probe).toHaveBeenCalledTimes(2)
    expect(vi.mocked(options.probe.probe).mock.calls[1]?.[2]).not.toBe(vi.mocked(options.probe.probe).mock.calls[0]?.[2])
    expect(options.cache.entries.get('codex')?.status).toBe('probe-passed')
  })
  it('reports repeated timeouts as unavailable and never persists a partial success', async () => {
    const options = fixture()
    vi.mocked(options.probe.probe).mockImplementation((_harness, _installation, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      if (signal.aborted) reject(signal.reason)
    }))
    const result = await create({ ...options, timeoutMs: 20 }).checkAll()
    expect(result[0]).toMatchObject({ status: 'unavailable', reason: { code: 'CHECK_TIMEOUT' } })
    expect(options.probe.probe).toHaveBeenCalledTimes(2)
    expect(options.cache.entries.size).toBe(0)
  })
  it('refreshes after qualification even when the initial diagnostic is still active', async () => {
    const options = fixture()
    let finish: (value: string) => void = () => undefined
    vi.mocked(options.probe.probe).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
      .mockResolvedValueOnce('b'.repeat(64))
    const service = create(options)
    service.start()
    await vi.waitFor(() => expect(options.probe.probe).toHaveBeenCalledTimes(1))
    service.refreshAfterQualification('codex')
    finish(sha)
    await vi.waitFor(() => expect(service.get('codex')).toMatchObject({ status: 'probe-passed', schemaSha256: 'b'.repeat(64) }))
    expect(options.probe.probe).toHaveBeenCalledTimes(2)
  })
  it('does not reuse a successful probe if the executable changes during it', async () => {
    const options = fixture()
    vi.mocked(options.probe.assertUnchanged).mockRejectedValue(new CompatibilityCheckError('CLI_CHANGED', 'The CLI changed.'))
    const result = await create(options).checkAll()
    expect(result[0]).toMatchObject({ status: 'probe-failed', reason: { code: 'CLI_CHANGED' } })
    expect(options.cache.entries.size).toBe(0)
  })
  it('stops pending checks on shutdown and refuses new work', async () => {
    const options = fixture()
    vi.mocked(options.probe.probe).mockImplementation((_harness, _installation, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      if (signal.aborted) reject(signal.reason)
    }))
    const service = create(options)
    service.start()
    await vi.waitFor(() => expect(options.probe.probe).toHaveBeenCalled())
    await service.close()
    expect(service.get('codex').status).toBe('unavailable')
    expect(() => service.retry('codex')).toThrow('closed')
  })
  it('does not launch another probe after unconfirmed process cleanup', async () => {
    const options = fixture()
    vi.mocked(options.probe.probe).mockRejectedValue(new CompatibilityCheckError('CLI_CLEANUP_FAILED', 'Shutdown unconfirmed.'))
    const service = create(options)
    await service.checkAll()
    const stopped = service.retry('codex')
    expect(stopped.reason?.code).toBe('CLI_CLEANUP_FAILED')
    expect(stopped.status).toBe('probe-failed')
    expect(options.probe.probe).toHaveBeenCalledTimes(1)
  })
})
