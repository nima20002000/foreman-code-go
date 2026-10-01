import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { NATIVE_GUARDIAN_SOURCE } from '../src/modules/harnesses/recovery/nativeGuardian.js'

/** Execute the actual guardian program against deterministic private storage and
 * process APIs. No executable, kernel cgroup, signal or host setting is touched. */
function guardianFixture(childAvailable = true) {
  const id = '11111111-1111-1111-1111-111111111111'
  const boot = '22222222-2222-2222-2222-222222222222'
  const records = new Map<string, string>()
  const descriptors = new Map<number, string>()
  const native = Object.assign(new EventEmitter(), { pid: 902 })
  const ipc: unknown[] = []
  const process = Object.assign(new EventEmitter(), {
    pid: 501, connected: true, getuid: () => 1000, kill: () => true,
    exit: () => undefined, send: (value: unknown) => ipc.push(value), stderr: { write: () => undefined },
  })
  records.set('/private/intent.json', JSON.stringify({ format: 1, id, boot, owner: 'same-lease', controlKey: 'a'.repeat(64) }))
  function stat(pid: number, ticks: string) {
    const parts = ['S', '1', '501', '501', ...Array<string>(15).fill('0'), ticks]
    return `${pid} (native cli) ${parts.join(' ')}`
  }
  const fs = {
    constants: { O_RDONLY: 1, O_NOFOLLOW: 2, O_CREAT: 4, O_EXCL: 8, O_WRONLY: 16, O_DIRECTORY: 32 },
    lstatSync: () => ({ isDirectory: () => true, isSymbolicLink: () => false, mode: 0o700, uid: 1000 }),
    openSync: (path: string) => { const fd = descriptors.size + 1; descriptors.set(fd, path); return fd },
    closeSync: () => undefined, fsyncSync: () => undefined,
    fstatSync: () => ({ isFile: () => true, nlink: 1, size: 100, mode: 0o600, uid: 1000, dev: 5n, ino: 6n }),
    readFileSync: (file: number | string) => {
      const path = typeof file === 'number' ? descriptors.get(file)! : file
      if (path === '/proc/501/stat') return stat(501, '100')
      if (path === '/proc/902/stat') { if (!childAvailable) throw new Error('ENOENT'); return stat(902, '200') }
      if (path === '/proc/self/cgroup') return '0::/delegated\n'
      if (path === '/proc/sys/kernel/random/boot_id') return boot
      const value = records.get(path)
      if (value === undefined) throw new Error(`Missing fixture record ${path}`)
      return value
    },
    writeFileSync: (file: number | string, value: string) => records.set(typeof file === 'number' ? descriptors.get(file)! : file, value),
    linkSync: (from: string, to: string) => { if (records.has(to)) throw new Error('EEXIST'); records.set(to, records.get(from)!) },
    unlinkSync: (path: string) => records.delete(path), mkdirSync: () => undefined, rmdirSync: () => undefined,
    statfsSync: () => ({ type: 0x63677270 }),
  }
  const server = { on: () => undefined, listen: (_options: unknown, callback: () => void) => callback(), maxConnections: 0 }
  const requireFixture = (module: string): unknown => {
    if (module === 'node:fs') return fs
    if (module === 'node:child_process') return { spawn: () => native }
    if (module === 'node:net') return { createServer: () => server }
    if (module === 'node:crypto') return { randomUUID: () => `${records.size}`, timingSafeEqual: () => true }
    if (module === 'node:path') return { join: (...parts: string[]) => parts.join('/').replaceAll('//', '/'), dirname: (path: string) => path.slice(0, path.lastIndexOf('/')) || '/', resolve: (...parts: string[]) => parts.join('/').replace('/./', '/').replaceAll('//', '/'), parse: () => ({ root: '/' }), sep: '/' }
    throw new Error(module)
  }
  runInNewContext(NATIVE_GUARDIAN_SOURCE, { require: requireFixture, process, Buffer, setTimeout: () => undefined })
  process.emit('message', { operation: 'start', directory: '/private', binary: 'actual-cli', args: ['private-argument'], cwd: '/workspace', environment: { SECRET: 'private-secret' } })
  return { records, native, ipc }
}

describe('guardian actual child observation receipts', () => {
  it('journals actual child PID/startTicks and positive CLI exit independently of wrapper termination', () => {
    const f = guardianFixture()
    const birth = JSON.parse(f.records.get('/private/provider.json')!) as Record<string, unknown>
    expect(birth).toMatchObject({ owner: 'same-lease', guardian: { pid: 501, startTicks: '100' }, provider: { pid: 902, startTicks: '200' }, capture: 'captured' })
    expect(JSON.stringify(birth)).not.toMatch(/private-argument|private-secret|SECRET|controlKey/)
    expect(f.ipc).toHaveLength(1)
    expect(f.records.has('/private/provider-exit.json')).toBe(false)
    f.native.emit('exit', 0, null)
    expect(JSON.parse(f.records.get('/private/provider-exit.json')!)).toMatchObject({ provider: { pid: 902, startTicks: '200' }, code: 0, signal: null })
    expect(f.ipc).toHaveLength(3)
    expect(f.ipc[2]).toMatchObject({ operation: 'native_exit', owner: 'same-lease', nativePid: 902, exitCode: 0, exitSignal: null })
  })
  it('keeps a disappeared-before-capture child uncertain and never substitutes the guardian PID', () => {
    const f = guardianFixture(false)
    const birth = JSON.parse(f.records.get('/private/provider.json')!) as Record<string, unknown>
    expect(birth.capture).toBe('unavailable')
    expect(birth.provider).toBeUndefined()
    f.native.emit('exit', null, 'SIGTERM')
    expect(JSON.parse(f.records.get('/private/provider-exit.json')!)).toMatchObject({ code: null, signal: 'SIGTERM' })
  })
})
