import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { waitForOwnedProcessesToExit } from './owned-processes.js'

interface ProcessObservation {
  uid: number
  cwdUid: number
  cwd: string | Error
}

const processes = vi.hoisted(() => new Map<string, ProcessObservation>())

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(async () => [...processes.keys()].map(name => ({ name, isDirectory: () => true }))),
  stat: vi.fn(async (path: string) => ({ uid: processes.get(path.split('/')[2]!)!.uid })),
  lstat: vi.fn(async (path: string) => ({ uid: processes.get(path.split('/')[2]!)!.cwdUid })),
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

it('excludes another owner’s protected cwd while waiting for an owned process to exit', async () => {
  processes.set('2032', {
    uid: 1000,
    cwdUid: 0,
    cwd: Object.assign(new Error('Protected process cwd'), { code: 'EACCES' }),
  })
  processes.set('3180', { uid: 1000, cwdUid: 1000, cwd: '/conformance-owned/native' })

  await expect(waitForOwnedProcessesToExit('/conformance-owned', 0)).rejects.toThrow(
    'Owned conformance processes remain after shutdown: 3180',
  )
  processes.delete('3180')
  await expect(waitForOwnedProcessesToExit('/conformance-owned', 0)).resolves.toBeUndefined()
})

it('retains a failure inspecting an owned process instead of declaring cleanup complete', async () => {
  const owned = { uid: 1000, cwdUid: 1000, cwd: '/conformance-owned/native' as string | Error }
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
    cwdUid: 1000,
    cwd: Object.assign(new Error('Process exited'), { code: 'ENOENT' }),
  })
  await expect(waitForOwnedProcessesToExit('/conformance-owned', 0)).resolves.toBeUndefined()
})
