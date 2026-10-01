import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const child = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: child.spawn }))
vi.mock('../src/modules/harnesses/recovery/linuxIdentity.js', () => ({
  bootIdentity: () => '22222222-2222-2222-2222-222222222222',
  processIdentity: (pid: number) => ({ pid, startTicks: '100', group: pid, session: pid, state: 'S' }),
  identityAlive: () => true,
}))

import { NativeProcessRegistry, nativeProcessExit, spawnNativeProcess } from '../src/modules/harnesses/recovery/processRegistry.js'
import { writeRecord } from '../src/modules/harnesses/recovery/storage.js'
import { createHash } from 'node:crypto'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.clearAllMocks() })

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'native-exit-observation-memory-'))
  roots.push(root)
  const registry = new NativeProcessRegistry(root)
  const scope = registry.reserveLaunch('memory-owner')
  const wrapper = Object.assign(new EventEmitter(), { pid: 501, send: vi.fn(), disconnect: vi.fn() })
  child.spawn.mockReturnValueOnce(wrapper)
  const process = spawnNativeProcess('memory-only-cli', [], { cwd: root, env: {}, recovery: scope })
  const receipt = { format: 1, operation: 'native_exit', id: scope.launchId, owner: scope.owner,
    boot: '22222222-2222-2222-2222-222222222222', guardian: { pid: 501, startTicks: '100' },
    nativePid: 902, exitCode: 0, exitSignal: null }
  return { root, registry, scope, process, receipt }
}

describe('native exit and passive observation IPC composition without subprocesses', () => {
  it('accepts the original exact native outcome around passive publications without adding receipt listeners', () => {
    const f = fixture()
    expect(f.process.listeners('message')).toHaveLength(1)
    f.process.emit('message', { operation: 'observation', id: f.scope.launchId })
    f.process.emit('message', { operation: 'observation', id: 'foreign-launch' })
    f.process.emit('message', f.receipt)
    f.process.emit('message', { operation: 'observation', id: f.scope.launchId })
    expect(nativeProcessExit(f.process, { exitCode: null, exitSignal: 'SIGKILL' })).toEqual({ exitCode: 0, exitSignal: null })
  })

  it('never promotes a passive observation to an original native success receipt', () => {
    const f = fixture()
    f.process.emit('message', { operation: 'observation', id: f.scope.launchId })
    expect(() => nativeProcessExit(f.process, { exitCode: 0, exitSignal: null })).toThrow('receipt is missing')
  })

  it('preserves exact guardian generation rejection after a passive publication', () => {
    const f = fixture()
    f.process.emit('message', { operation: 'observation', id: f.scope.launchId })
    f.process.emit('message', { ...f.receipt, guardian: { pid: 501, startTicks: '101' } })
    expect(() => nativeProcessExit(f.process, { exitCode: null, exitSignal: 'SIGKILL' })).toThrow('Invalid native exit receipt')
  })

  it('does not let observation read failure poison the original native receipt', () => {
    const f = fixture()
    const directory = join(f.root, createHash('sha256').update(f.scope.owner).digest('hex'), f.scope.launchId!)
    writeRecord(join(directory, 'provider.json'), { format: 1, id: 'foreign', owner: f.scope.owner, boot: f.receipt.boot })
    f.process.emit('message', { operation: 'observation', id: f.scope.launchId })
    f.process.emit('message', f.receipt)
    expect(nativeProcessExit(f.process, { exitCode: null, exitSignal: 'SIGKILL' })).toEqual({ exitCode: 0, exitSignal: null })
  })
})
