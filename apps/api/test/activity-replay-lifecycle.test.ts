import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import { FileByteStorage } from '../src/modules/files/storage.js'
import { createActivityReplayFileStorage, startActivityReplayProduction } from './helpers/activityReplayLifecycle.js'

it('initializes real private fixture storage outside the temporary workspace and harness roots', async () => {
  const root = await createActivityReplayFileStorage()
  const workspace = join(tmpdir(), 'recorded-activity-workspace')
  try {
    await expect(new FileByteStorage(root, 1024, [workspace]).initialize()).resolves.toBeUndefined()
    await expect(new FileByteStorage(join(workspace, 'files'), 1024, [workspace]).initialize())
      .rejects.toThrow('File storage must be separate from temporary, workspace, and harness directories.')
    await expect(new FileByteStorage(root, 1024, [root]).initialize())
      .rejects.toThrow('File storage must be separate from temporary, workspace, and harness directories.')
  } finally { await rm(root, { recursive: true, force: true }) }
})

for (const boundary of ['register', 'initialize', 'listen'] as const) {
  it(`retains shutdown before a failed ${boundary} startup boundary`, async () => {
    const closes: Array<() => Promise<void>> = []
    const failure = new Error(`failed ${boundary}`)
    const enter = (name: typeof boundary) => {
      expect(closes).toHaveLength(1)
      if (boundary === name) throw failure
    }
    const shutdown = vi.fn(async () => undefined), drain = vi.fn(async () => undefined)
    const production = { registerFileStorage: () => { enter('register'); return undefined },
      initialize: async () => { enter('initialize') }, shutdown,
      app: { listen: vi.fn(async () => { enter('listen'); return 'http://127.0.0.1:1' }) } }
    await expect(startActivityReplayProduction(production, { drain }, closes, 1)).rejects.toBe(failure)
    await closes.pop()!()
    expect(drain).toHaveBeenCalledOnce()
    expect(shutdown).toHaveBeenCalledOnce()
  })
}

it('shuts down the exact initial and restarted instances even if replay drain fails', async () => {
  const closes: Array<() => Promise<void>> = []
  const initial = vi.fn(async () => undefined), restarted = vi.fn(async () => undefined)
  const failure = new Error('replay drain failed')
  const replay = { drain: async () => { throw failure } }
  for (const shutdown of [initial, restarted]) {
    await startActivityReplayProduction({ registerFileStorage: () => undefined, initialize: async () => {},
      shutdown, app: { listen: async () => 'http://127.0.0.1:1' } }, replay, closes, 1)
  }
  await expect(closes.pop()!()).rejects.toBe(failure)
  expect(restarted).toHaveBeenCalledOnce()
  expect(initial).not.toHaveBeenCalled()
  await expect(closes.pop()!()).rejects.toBe(failure)
  expect(initial).toHaveBeenCalledOnce()
})
