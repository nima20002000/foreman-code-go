import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { rm } from 'node:fs/promises'
import type { PreparedCiRuntime } from '@foreman-code/contracts'
import { privateFixtureDirectory } from '../../../test/helpers/privateFixtureDirectory.js'
import { CiRuntimeWorker, type CiRuntimeWorkerPorts } from './ciRuntimeWorker.js'
import { verificationRuntimeFixture } from '../../../test/helpers/verificationRuntimeFixture.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(prepare: CiRuntimeWorkerPorts['prepare'],
  options: Pick<CiRuntimeWorkerPorts, 'refresh'> = { refresh: vi.fn() }) {
  const root = await privateFixtureDirectory('ci-worker-lifetime-')
  roots.push(root)
  const lifetime = new AbortController()
  const worker = new CiRuntimeWorker(root, {
    git: { cloneDirectory: () => root, git: async () => ({ code: 0, stdout: '', stderr: '' }) },
    managedRuntimeRoot: async () => root,
    currentRuntimePaths: async () => [], prepare, ...options, lastRefresh: async () => null,
    now: () => new Date(),
  }, lifetime.signal)
  const request = { operation: 'prepare', operationId: randomUUID(), repository: 'fixture/site',
    commit: 'a'.repeat(40), keepImages: [],
    review: { reviewedByPrincipalId: 'owner', decisionDigest: 'b'.repeat(64) } }
  const prepared: PreparedCiRuntime = { commit: request.commit, imageId: `sha256:${'c'.repeat(64)}`,
    imageManifestDigest: `sha256:${'d'.repeat(64)}`, qualificationSource: `${root}/source`,
    seedReceiptPath: `${root}/seed.json`, contextReceiptPath: `${root}/context.json` }
  return { worker, lifetime, request, prepared }
}

describe('worker CI preparation lifetime', () => {
  it('rejects legacy refresh on a Host CI computer while preserving idle, pending and prepared status', async () => {
    let finish!: (value: PreparedCiRuntime) => void
    const native = new Promise<PreparedCiRuntime>(resolve => { finish = resolve })
    const prepare = vi.fn<CiRuntimeWorkerPorts['prepare']>(() => native)
    const f = await fixture(prepare, {})
    const fingerprint = verificationRuntimeFixture().measurement.fingerprint
    const refresh = { operation: 'refresh', operationId: f.request.operationId, commit: f.request.commit,
      root: fingerprint.root, resources: fingerprint.resources,
      manifest: { version: 1, ...fingerprint.root.source,
        git: { commit: f.request.commit, tree: 'a'.repeat(40), objectFormat: 'sha1' },
        capturePolicy: 'git-tree-v1', executablePolicy: 'preserve-approved', entries: [], deletions: [],
        totalEntries: 0, totalBytes: 0 } }
    try {
      await expect(f.worker.handle(refresh)).rejects.toMatchObject({ code: 'CI_RUNTIME_RETIRED' })
      expect(await f.worker.handle({ operation: 'status' })).toMatchObject({ state: 'idle', stage: null })
      expect(prepare).not.toHaveBeenCalled()
      await f.worker.handle(f.request)
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce())
      await expect(f.worker.handle(refresh)).rejects.toMatchObject({ code: 'CI_RUNTIME_RETIRED' })
      expect(await f.worker.handle({ operation: 'status' })).toMatchObject({ state: 'preparing' })
      finish(f.prepared)
      await f.worker.close()
      await expect(f.worker.handle(refresh)).rejects.toMatchObject({ code: 'CI_RUNTIME_RETIRED' })
      expect(await f.worker.handle({ operation: 'status' })).toMatchObject({ state: 'prepared', stage: null })
    } finally {
      finish(f.prepared)
      await f.worker.close()
    }
  })

  it('returns preparing while work continues and joins it on close', async () => {
    let finish!: (value: PreparedCiRuntime) => void
    const native = new Promise<PreparedCiRuntime>(resolve => { finish = resolve })
    const prepare = vi.fn<CiRuntimeWorkerPorts['prepare']>(() => native)
    const f = await fixture(prepare)
    try {
      expect((await f.worker.handle(f.request)).state).toBe('preparing')
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce())
      expect(prepare.mock.calls[0]?.[0].signal).toBe(f.lifetime.signal)
      let closed = false
      const closing = f.worker.close().then(() => { closed = true })
      await new Promise(resolve => setImmediate(resolve))
      expect(closed).toBe(false)
      finish(f.prepared)
      await closing
      expect(await f.worker.handle({ operation: 'status' })).toMatchObject({ state: 'prepared', prepared: f.prepared })
    } finally {
      finish(f.prepared)
      await f.worker.close()
    }
  })

  it('joins cancelled preparation before shutdown and never publishes its late result', async () => {
    let finish!: (value: PreparedCiRuntime) => void
    const native = new Promise<PreparedCiRuntime>(resolve => { finish = resolve })
    const prepare = vi.fn<CiRuntimeWorkerPorts['prepare']>(() => native)
    const f = await fixture(prepare)
    try {
      await f.worker.handle(f.request)
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce())
      f.lifetime.abort(new Error('Worker shutdown'))
      let closed = false
      const closing = f.worker.close().then(() => { closed = true })
      await new Promise(resolve => setImmediate(resolve))
      expect(closed).toBe(false)
      finish(f.prepared)
      await closing
      expect(await f.worker.handle({ operation: 'status' })).toMatchObject({
        state: 'failed', prepared: null, message: 'Worker shutdown',
      })
      await expect(f.worker.handle(f.request)).rejects.toThrow('Worker shutdown')
    } finally {
      finish(f.prepared)
      await f.worker.close()
    }
  })
})
