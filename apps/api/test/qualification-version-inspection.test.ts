import { createHash } from 'node:crypto'
import { appendFile, chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { nativeCompatibilityProbe, type CompatibilityProbe } from '../src/modules/harnesses/compatibility/probe.js'
import { HarnessQualificationService } from '../src/modules/harnesses/qualification/service.js'
import { removeFixtureDirectory } from './helpers/testResources.js'

function gate() {
  let resolve!: () => void
  return { promise: new Promise<void>(done => { resolve = done }), release: () => resolve() }
}

function service(binary: string, factory: (timeoutMs: number) => CompatibilityProbe) {
  const save = vi.fn(async () => undefined)
  const run = vi.fn(async () => ({ checks: [{ id: 'recorded', passed: true, detail: null }], evidence: {} }))
  const qualification = new HarnessQualificationService({ find: async () => null, save } as never,
    { inspectBinary: async () => ({ binary, sha256: createHash('sha256')
      .update(await readFile(binary)).digest('hex') }), trusted: async () => true } as never,
    { codex: { harness: 'codex', revision: 'recorded', run }, opencode: { harness: 'opencode', revision: 'recorded', run } },
    { codex: binary, opencode: binary }, {} as never,
    { getManagedHarnessDefaults: async () => ({ revision: 0, defaults: DEFAULT_HARNESS_DEFAULTS }) },
    async () => 'recorded-schema', undefined, (_harness, _binary, timeoutMs) => factory(timeoutMs))
  return { qualification, run, save }
}

async function binaryFixture(program: string) {
  const directory = await mkdtemp(join(tmpdir(), 'qualification-version-'))
  const binary = join(directory, 'native-cli')
  await writeFile(binary, `#!${process.execPath}\n${program}\n`, { mode: 0o700 })
  await chmod(binary, 0o700)
  return { directory, binary }
}

it('keeps installation verification and closure outside the native version-command deadline', async () => {
  const f = await binaryFixture("console.log('codex-cli 0.154.0')")
  const verifying = gate()
  const verified = gate()
  const closing = gate()
  const closed = gate()
  const instance = service(f.binary, timeoutMs => {
    const raw = nativeCompatibilityProbe({ codex: f.binary, opencode: f.binary }, f.directory, process.env, timeoutMs)
    return { ...raw, async inspect(harness, signal) {
      verifying.release()
      await verified.promise
      signal.throwIfAborted()
      const result = await raw.inspect(harness, signal)
      closing.release()
      await closed.promise
      signal.throwIfAborted()
      return result
    } }
  })
  vi.useFakeTimers()
  const admitted = instance.qualification.begin('codex')
  const result = admitted.then(value => ({ value }), error => ({ error }))
  try {
    await verifying.promise
    await vi.advanceTimersByTimeAsync(6000)
    verified.release()
    await closing.promise
    await vi.advanceTimersByTimeAsync(6000)
    closed.release()
    expect(await result).toMatchObject({ value: { version: '0.154.0', status: 'qualifying' } })
    await instance.qualification.join()
    expect(instance.run).toHaveBeenCalledOnce()
    expect(instance.save).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'qualified' }),
      expect.any(Object))
  } finally {
    verified.release()
    closed.release()
    await result
    vi.useRealTimers()
    await instance.qualification.shutdown()
    await removeFixtureDirectory(f.directory)
  }
})

it('refuses a binary replacement after version inspection before admitting its suite', async () => {
  const f = await binaryFixture("console.log('codex-cli 0.160.1')")
  const instance = service(f.binary, timeoutMs => {
    const raw = nativeCompatibilityProbe({ codex: f.binary, opencode: f.binary }, f.directory, process.env, timeoutMs)
    return { ...raw, async inspect(harness, signal) {
      const result = await raw.inspect(harness, signal)
      await appendFile(f.binary, '\n// replacement payload\n')
      return result
    } }
  })
  try {
    await instance.qualification.begin('codex')
    await instance.qualification.join()
    expect(instance.run).not.toHaveBeenCalled()
    expect(instance.save).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'failed',
      version: '0.160.1', failureReason: expect.stringContaining('changed before its native contract checks') }))
  } finally {
    await instance.qualification.shutdown()
    await removeFixtureDirectory(f.directory)
  }
})

it('still stops a stalled version command at the native deadline without admitting a suite', async () => {
  const f = await binaryFixture('setInterval(() => {}, 1000)')
  const instance = service(f.binary, timeoutMs => nativeCompatibilityProbe(
    { codex: f.binary, opencode: f.binary }, f.directory, process.env, timeoutMs))
  try {
    await expect(instance.qualification.begin('codex')).rejects.toMatchObject({ name: 'TimeoutError' })
    await instance.qualification.join()
    expect(instance.run).not.toHaveBeenCalled()
    expect(instance.save).not.toHaveBeenCalled()
  } finally {
    await instance.qualification.shutdown()
    await removeFixtureDirectory(f.directory)
  }
}, 10_000)
