import { expect, it, vi } from 'vitest'
import { systemSyncthingPorts } from './syncthingSystem.js'

const filesystem = vi.hoisted(() => ({ inspected: 0 }))
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  const entry = { name: 'ordinary.txt', isFile: () => { filesystem.inspected++; return true }, isDirectory: () => false }
  return { ...original,
    readdir: async () => Array.from({ length: 20_000 }, () => entry),
    opendir: async () => ({
      async *[Symbol.asyncIterator]() {
        for (let index = 0; index < 20_000; index++) yield entry
      },
    }),
  }
})

it('bounds conflict traversal even when every file is ordinary', async () => {
  const ports = systemSyncthingPorts()
  expect(await ports.conflicts('/shared/workspace')).toEqual([])
  expect(filesystem.inspected).toBe(10_000)
})
