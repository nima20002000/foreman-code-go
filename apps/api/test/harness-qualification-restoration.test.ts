import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { ManagementPrincipalSchema } from '@foreman-code/contracts/management'
import type { HarnessQualification } from '@foreman-code/contracts/harness-qualification'
import { CompatibilityCheckError } from '../src/modules/harnesses/compatibility/errors.js'
import { HarnessQualificationService } from '../src/modules/harnesses/qualification/service.js'
import { DomainError } from '../src/modules/errors.js'

vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(async () => undefined) }))

const directories: string[] = []

afterEach(async () => {
  vi.mocked(delay).mockReset()
  vi.mocked(delay).mockResolvedValue(undefined)
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function fixture(previousStatus: 'qualified' | 'failed' | null = 'qualified') {
  const directory = await mkdtemp(join(tmpdir(), 'harness-qualification-restoration-'))
  directories.push(directory)
  const binary = join(directory, 'native-cli')
  const bytes = Buffer.from('qualification binary identity fixture; never executed')
  await writeFile(binary, bytes, { mode: 0o700 })
  const binarySha256 = createHash('sha256').update(bytes).digest('hex')
  const record: HarnessQualification = {
    harness: 'codex', version: '0.162.1', binarySha256,
    suiteRevision: 'restoration-suite', profile: 'codex-0.156', status: 'qualified',
    checks: [{ id: 'native-turn', passed: true, detail: null }], failureReason: null,
    startedAt: '2026-10-01T00:00:00.000Z', checkedAt: '2026-10-01T00:00:01.000Z',
  }
  let persisted: HarnessQualification | null = previousStatus ? { ...record, status: previousStatus } : null
  const find = vi.fn(async () => persisted)
  const save = vi.fn(async (value: HarnessQualification) => { persisted = value })
  const inspect = vi.fn(async () => ({ executable: binary, identity: 'installation', version: record.version }))
  const close = vi.fn(async () => undefined)
  const refresh = vi.fn(async () => undefined)
  const run = vi.fn(async () => ({ checks: record.checks, evidence: { environment: 'restarted' } }))
  const qualification = new HarnessQualificationService({ find, save,
    list: async () => persisted ? [persisted] : [] } as never,
    { inspectBinary: async () => ({ binary, sha256: record.binarySha256 }), trusted: async () => true } as never,
    { codex: { harness: 'codex', revision: record.suiteRevision, run } }, { codex: binary }, {} as never,
    { getManagedHarnessDefaults: async () => ({ revision: 0, defaults: DEFAULT_HARNESS_DEFAULTS }) },
    async () => 'schema', undefined,
    () => ({ inspect, close, probe: async () => 'schema', assertUnchanged: async () => undefined }), refresh)
  return { qualification, record, find, save, inspect, close, refresh, run }
}

it.each([
  new DOMException('Version check timed out', 'TimeoutError'),
  new CompatibilityCheckError('CHECK_TIMEOUT', 'Version check timed out'),
  new DomainError('HARNESS_CHECK_TIMEOUT', 'Inventory check timed out', 503),
])('restores a qualified binary after transient startup inspection failures: $name', async error => {
  const f = await fixture()
  f.inspect.mockRejectedValueOnce(error).mockRejectedValueOnce(error)
  try {
    expect(await f.qualification.restore('codex')).toMatchObject({ status: 'qualifying', version: '0.162.1' })
    await f.qualification.join()
    expect(f.inspect).toHaveBeenCalledTimes(3)
    expect(f.close).toHaveBeenCalledTimes(3)
    expect(f.refresh).toHaveBeenCalledTimes(3)
    expect(f.run).toHaveBeenCalledOnce()
    const reader = ManagementPrincipalSchema.parse({ id: 'qualification-reader', name: 'Qualification reader',
      audience: 'operator', grants: [{ actions: ['harnesses:read'], scope: {} }],
      expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null })
    expect(await f.qualification.list(reader))
      .toMatchObject({ qualifications: [{ status: 'qualified', version: '0.162.1',
        binarySha256: f.record.binarySha256, checks: expect.arrayContaining(f.record.checks) }] })
  } finally { await f.qualification.shutdown() }
})

it.each(['failed', null] as const)('does not restore an unqualified binary after a timeout: %s', async status => {
  const f = await fixture(status)
  f.inspect.mockRejectedValueOnce(new DOMException('Version check timed out', 'TimeoutError'))
  try {
    expect(await f.qualification.restore('codex')).toBeNull()
    await f.qualification.join()
    expect(f.inspect).toHaveBeenCalledTimes(2)
    expect(f.run).not.toHaveBeenCalled()
    expect(f.save).not.toHaveBeenCalled()
  } finally { await f.qualification.shutdown() }
})

it('keeps automatic Main profile verification pending through startup inspection timeouts', async () => {
  const f = await fixture()
  f.refresh.mockRejectedValueOnce(new DOMException('Inventory timed out', 'TimeoutError'))
  f.inspect.mockRejectedValueOnce(new CompatibilityCheckError('CHECK_TIMEOUT', 'Version check timed out'))
  try {
    expect(await f.qualification.verify('codex', { force: true })).toMatchObject({
      status: 'qualified', version: '0.162.1', binarySha256: f.record.binarySha256,
    })
    expect(f.refresh).toHaveBeenCalledTimes(3)
    expect(f.inspect).toHaveBeenCalledTimes(2)
    expect(f.run).toHaveBeenCalledOnce()
  } finally { await f.qualification.shutdown() }
})

it('coalesces restart restoration and cancels the retry wait on shutdown', async () => {
  const f = await fixture()
  f.inspect.mockRejectedValue(new DOMException('Version check timed out', 'TimeoutError'))
  vi.mocked(delay).mockImplementation((_milliseconds, _value, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
  }))
  const restored = f.qualification.restore('codex')
  const rejected = expect(restored).rejects.toMatchObject({ name: 'AbortError' })
  try {
    expect(f.qualification.restore('codex')).toBe(restored)
    await vi.waitFor(() => expect(delay).toHaveBeenCalledOnce())
    await f.qualification.shutdown()
    await rejected
    expect(f.inspect).toHaveBeenCalledOnce()
    expect(f.run).not.toHaveBeenCalled()
  } finally { await f.qualification.shutdown() }
})

it('does not retry an inspection whose native cleanup is unconfirmed', async () => {
  const f = await fixture()
  f.inspect.mockRejectedValueOnce(new DOMException('Version check timed out', 'TimeoutError'))
  f.close.mockRejectedValueOnce(new Error('Unconfirmed cleanup'))
  try {
    await expect(f.qualification.restore('codex')).rejects.toBeInstanceOf(AggregateError)
    expect(delay).not.toHaveBeenCalled()
    expect(f.inspect).toHaveBeenCalledOnce()
    expect(f.run).not.toHaveBeenCalled()
  } finally { await f.qualification.shutdown() }
})
