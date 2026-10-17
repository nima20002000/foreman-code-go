import { readlink } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { waitForOwnedProcessesToExit } from './owned-processes.js'

interface ProcessObservation {
  uid: number
  cwd: string | Error
  startTicks: string | Error
}

const processes = vi.hoisted(() => new Map<string, ProcessObservation>())

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(async () => [...processes.keys()].map(name => ({ name, isDirectory: () => true }))),
  stat: vi.fn(async (path: string) => ({ uid: processes.get(path.split('/')[2]!)!.uid })),
  lstat: vi.fn(async () => ({ uid: 1000 })),
  readFile: vi.fn(async (path: string) => {
    const startTicks = path === '/proc/self/stat' ? '100' : processes.get(path.split('/')[2]!)!.startTicks
    if (startTicks instanceof Error) throw startTicks
    const fields = ['S', ...Array<string>(18).fill('0'), startTicks]
    return `3180 (process with (nested) name) ${fields.join(' ')}`
  }),
  readlink: vi.fn(async (path: string) => {
    const cwd = processes.get(path.split('/')[2]!)!.cwd
    if (cwd instanceof Error) throw cwd
    return cwd
  }),
}))

beforeEach(() => {
  processes.clear()
  vi.spyOn(process, 'getuid').mockReturnValue(1000)
})

afterEach(() => { vi.restoreAllMocks() })

it('excludes an inaccessible pre-existing process while waiting for an owned process to exit', async () => {
  processes.set('2032', {
    uid: 1000,
    cwd: Object.assign(new Error('Protected process cwd'), { code: 'EACCES' }),
    startTicks: '10',
  })
  processes.set('3180', { uid: 1000, cwd: '/conformance-owned/native', startTicks: '200' })

  await expect(waitForOwnedProcessesToExit('/conformance-owned', 0)).rejects.toThrow(
    'Owned conformance processes remain after shutdown: 3180',
  )
  processes.delete('3180')
  await expect(waitForOwnedProcessesToExit('/conformance-owned', 0)).resolves.toBeUndefined()
})

it('retains a failure inspecting an owned process instead of declaring cleanup complete', async () => {
  const owned = { uid: 1000, cwd: '/conformance-owned/native' as string | Error, startTicks: '200' }
  processes.set('3180', owned)
  await expect(waitForOwnedProcessesToExit('/conformance-owned', 0)).rejects.toThrow(
    'Owned conformance processes remain after shutdown: 3180',
  )

  const denied = Object.assign(new Error('Owned process cwd unavailable'), { code: 'EACCES' })
  owned.cwd = denied
  await expect(waitForOwnedProcessesToExit('/conformance-owned', 0)).rejects.toMatchObject({
    message: 'Could not establish process 3180 cleanup ownership', cause: denied,
  })
})

it('accepts a process disappearing before its cwd can be observed', async () => {
  processes.set('3180', {
    uid: 1000,
    cwd: Object.assign(new Error('Process exited'), { code: 'ENOENT' }),
    startTicks: '200',
  })
  await expect(waitForOwnedProcessesToExit('/conformance-owned', 0)).resolves.toBeUndefined()
})

it('retains a readable untracked process using the owned root even if it predates the launcher', async () => {
  processes.set('3180', { uid: 1000, cwd: '/conformance-owned/native', startTicks: '10' })
  await expect(waitForOwnedProcessesToExit('/conformance-owned', 0)).rejects.toThrow(
    'Owned conformance processes remain after shutdown: 3180',
  )
})

it.each(['100', '200'])('retains an inaccessible process whose start ticks are %s', async startTicks => {
  const denied = Object.assign(new Error('Process cwd unavailable'), { code: 'EPERM' })
  processes.set('3180', { uid: 1000, cwd: denied, startTicks })
  await expect(waitForOwnedProcessesToExit('/conformance-owned', 0)).rejects.toMatchObject({
    message: 'Could not establish process 3180 cleanup ownership', cause: denied,
  })
})

it.each([
  { name: 'unreadable', startTicks: Object.assign(new Error('Process identity unavailable'), { code: 'EACCES' }) },
  { name: 'malformed', startTicks: 'unknown' },
])('retains an inaccessible process when its start time is $name', async ({ startTicks }) => {
  const denied = Object.assign(new Error('Process cwd unavailable'), { code: 'EACCES' })
  processes.set('3180', { uid: 1000, cwd: denied, startTicks })
  await expect(waitForOwnedProcessesToExit('/conformance-owned', 0)).rejects.toMatchObject({
    message: 'Could not establish process 3180 cleanup ownership',
    cause: denied,
    errors: [denied, expect.any(Error)],
  })
})

it('accepts an inaccessible process that disappears before its identity can be read', async () => {
  processes.set('3180', {
    uid: 1000,
    cwd: Object.assign(new Error('Process cwd unavailable'), { code: 'EACCES' }),
    startTicks: Object.assign(new Error('Process exited'), { code: 'ESRCH' }),
  })
  await expect(waitForOwnedProcessesToExit('/conformance-owned', 0)).resolves.toBeUndefined()
})

it('does not exclude a reused PID based on the earlier process generation', async () => {
  const denied = Object.assign(new Error('Process cwd unavailable'), { code: 'EACCES' })
  const observed = { uid: 1000, cwd: denied, startTicks: '10' }
  processes.set('3180', observed)
  vi.mocked(readlink).mockImplementationOnce(async () => {
    observed.startTicks = '200'
    throw denied
  })
  await expect(waitForOwnedProcessesToExit('/conformance-owned', 0)).rejects.toMatchObject({
    message: 'Could not establish process 3180 cleanup ownership', cause: denied,
  })
})
