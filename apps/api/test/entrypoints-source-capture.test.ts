import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
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
