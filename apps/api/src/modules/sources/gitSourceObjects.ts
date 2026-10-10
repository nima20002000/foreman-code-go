import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { SourceManifest } from '@foreman-code/contracts/source-materialization'
import { ensureClone, type GitWorktreePorts } from './gitWorktree.js'
import { SOURCE_LIMITS, SourceError, verifySourceBytes } from './manifest.js'

const ObjectsSchema = z.array(z.object({
  kind: z.enum(['commit', 'tree']), object: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  bytes: z.string().max(3 * 1024 * 1024),
}).strict()).min(2).max(SOURCE_LIMITS.entries * 32 + 1)

/** Delivers only the approved commit, trees and blobs; repository history is not source approval. */
export async function importGitSourceObjects(input: {
  ports: GitWorktreePorts; repository: string; manifest: SourceManifest; metadata: Uint8Array;
  blobPath(path: string): Promise<string>; signal: AbortSignal;
}): Promise<string> {
  const { ports, manifest, signal } = input
  const provenance = manifest.git
  if (!provenance?.metadata) throw new SourceError('SOURCE_GIT_OBJECT_UNAVAILABLE', 'Approved Git metadata is missing.')
  verifySourceBytes({ ...provenance.metadata, path: 'git-objects.json', kind: 'file', executable: false }, input.metadata)
  const objects = ObjectsSchema.parse(JSON.parse(Buffer.from(input.metadata).toString('utf8')))
  const clone = await ensureClone(ports, input.repository, signal)
  const scratch = await mkdtemp(join(tmpdir(), 'foreman-source-objects-'))
  const git = async (args: string[]) => {
    const result = await ports.git(['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: clone, signal })
    if (result.code !== 0) throw new SourceError('SOURCE_GIT_OBJECT_UNAVAILABLE', 'The approved Git objects could not be imported.')
    return result.stdout.trim()
  }
  try {
    for (const object of objects) {
      signal.throwIfAborted()
      const bytes = Buffer.from(object.bytes, 'base64')
      const hash = createHash(provenance.objectFormat).update(`${object.kind} ${bytes.length}\0`).update(bytes).digest('hex')
      if (hash !== object.object) throw new SourceError('SOURCE_GIT_OBJECT_CORRUPT', 'Git metadata has an invalid object identity.')
      const file = join(scratch, 'object')
      await writeFile(file, bytes, { mode: 0o600 })
      if (await git(['hash-object', '-w', '-t', object.kind, '--no-filters', file]) !== object.object) {
        throw new SourceError('SOURCE_GIT_OBJECT_CORRUPT', 'The destination uses another Git object format.')
      }
    }
    for (const entry of manifest.entries) {
      signal.throwIfAborted()
      await git(['hash-object', '-w', '--no-filters', await input.blobPath(entry.path)])
    }
    if (!objects.some(object => object.kind === 'commit' && object.object === provenance.commit)
      || await git(['rev-parse', `${provenance.commit}^{tree}`]) !== provenance.tree) {
      throw new SourceError('SOURCE_GIT_OBJECT_CORRUPT', 'Git metadata does not contain the approved commit and tree.')
    }
    await git(['update-ref', `refs/foreman/sources/${manifest.snapshotId}`, provenance.commit])
    return clone
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
