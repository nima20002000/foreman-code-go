import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import { captureGitSource, qualifiedGit } from '../src/modules/sources/capture.js'
import { PrivateSourceSnapshotStore } from '../src/modules/sources/store.js'

it('captures this complete committed repository into real private storage within the existing source budget', async () => {
  const root = await realpath(fileURLToPath(new URL('../../../', import.meta.url)))
  const commit = (await qualifiedGit(root, ['rev-parse', 'HEAD'])).toString().trim()
  const approvedPaths = (await qualifiedGit(root, ['ls-tree', '-r', '--name-only', '-z', commit])).toString().split('\0').filter(Boolean)
  const directory = await mkdtemp('/var/tmp/entrypoints-source-capture-')
  try {
    const store = new PrivateSourceSnapshotStore(directory)
    const manifest = await captureGitSource({ root, commit, approvedSourceId: randomUUID(), approvedPaths, executablePolicy: 'strip', sink: store })
    expect(manifest.git?.commit).toBe(commit)
    expect(manifest.entries.map(entry => entry.path)).toEqual([...approvedPaths].sort())
    expect(manifest.entries.length).toBeGreaterThan(2000)
    const entry = manifest.entries.find(value => value.path === 'AGENTS.md')!
    expect(Buffer.from(await store.read(manifest, entry, AbortSignal.timeout(1000))).toString()).toContain('Repository instructions')
  } finally { await rm(directory, { recursive: true, force: true }) }
}, 60_000)

it('joins the actual Git child after cancellation with unread batch output', async () => {
  const directory = await mkdtemp('/var/tmp/entrypoints-source-abort-'), root = join(directory, 'repo'), storage = join(directory, 'storage')
  await mkdir(root, { mode: 0o700 }); await mkdir(storage, { mode: 0o700 })
  const store = new PrivateSourceSnapshotStore(storage), abort = vi.spyOn(store, 'abort'), commitSink = vi.spyOn(store, 'commit')
  try {
    await qualifiedGit(root, ['init', '-q'])
    for (const name of ['first.bin', 'second.bin']) await writeFile(join(root, name), Buffer.alloc(512 * 1024, 1))
    await qualifiedGit(root, ['add', '.'])
    await qualifiedGit(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', 'Fixture'])
    const commit = (await qualifiedGit(root, ['rev-parse', 'HEAD'])).toString().trim(), controller = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
    try {
      await expect(captureGitSource({ root, commit, approvedSourceId: randomUUID(), approvedPaths: ['first.bin', 'second.bin'], executablePolicy: 'strip',
        sink: { write: async (...args) => { await store.write(...args); controller.abort(new Error('Capture stopped in sink.')) },
          commit: store.commit.bind(store), abort: store.abort.bind(store) } })).rejects.toThrow('Capture stopped in sink.')
      expect(abort).toHaveBeenCalledOnce(); expect(commitSink).not.toHaveBeenCalled()
    } finally { timeout.mockRestore() }
  } finally { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }) }
})
