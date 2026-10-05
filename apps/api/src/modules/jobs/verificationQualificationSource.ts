import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import type { SourceManifest } from '@foreman-code/contracts/source-materialization'
import { JobVerificationPrivateGitSchema } from '@foreman-code/contracts/job-verification-runtime'
import { openPrivateRoot, entryParent, anchored, identity } from '../sources/privateFilesystem.js'
import { verifyMaterializedSourceTree } from '../sources/materialization.js'
import { verifySourceBytes, verifySourceManifest } from '../sources/manifest.js'

/** Copies only the approved snapshot and constructs its history-free Git view. */
export async function prepareVerificationQualificationSource(input: {
  directory: string
  manifest: SourceManifest
  namespace: string
  signal: AbortSignal
}) {
  const manifest = verifySourceManifest(input.manifest)
  if (!manifest.git) throw new Error('Approved Git snapshot required for verification qualification.')
  const original = await openPrivateRoot(input.directory)
  const sourceRoot = join(input.namespace, 'tree')
  const gitDirectory = join(input.namespace, 'repository')
  const schedulerDirectory = join(input.namespace, 'job-heavy-jobs')
  await mkdir(sourceRoot, { mode: 0o700 })
  await mkdir(gitDirectory, { mode: 0o700 })
  await mkdir(schedulerDirectory, { mode: 0o700 })
  await mkdir(join(gitDirectory, 'objects'), { mode: 0o700 })
  await mkdir(join(gitDirectory, 'refs'), { mode: 0o700 })
  await mkdir(join(gitDirectory, 'graphql-heavy-jobs'), { mode: 0o700 })
  const destination = await openPrivateRoot(sourceRoot)
  const format = manifest.git.objectFormat
  const object = async (kind: string, bytes: Buffer) => {
    const content = Buffer.concat([Buffer.from(`${kind} ${bytes.length}\0`), bytes])
    const id = createHash(format).update(content).digest('hex')
    await mkdir(join(gitDirectory, 'objects', id.slice(0, 2)), { mode: 0o700, recursive: true })
    await writeFile(join(gitDirectory, 'objects', id.slice(0, 2), id.slice(2)), deflateSync(content), { mode: 0o600 })
    return id
  }
  const files: Array<{ path: string; id: string; mode: number; size: number }> = []
  try {
    await verifyMaterializedSourceTree(original, manifest, input.signal)
    for (const entry of manifest.entries) {
      input.signal.throwIfAborted()
      const source = await entryParent(original, entry.path, false)
      const target = await entryParent(destination, entry.path, true)
      try {
        const file = await open(anchored(source.parent, source.leaf), constants.O_RDONLY | constants.O_NOFOLLOW)
        let bytes: Buffer
        try {
          const before = await file.stat()
          bytes = await file.readFile({ signal: input.signal })
          const after = await file.stat()
          if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
            throw new Error('Approved qualification source changed during copy.')
          }
          verifySourceBytes(entry, bytes)
        } finally { await file.close() }
        await writeFile(anchored(target.parent, target.leaf), bytes, {
          mode: entry.executable ? 0o700 : 0o600, flag: 'wx', signal: input.signal,
        })
        files.push({ path: entry.path, id: await object('blob', bytes),
          mode: entry.executable ? 0o100755 : 0o100644, size: entry.byteSize })
      } finally { await source.parent.close(); await target.parent.close() }
    }
    await verifyMaterializedSourceTree(destination, manifest, input.signal)
  } finally { await original.close(); await destination.close() }
  const tree = async (prefix: string): Promise<string> => {
    const entries = new Map<string, { mode: string; id: string }>()
    for (const file of files.filter(value => value.path.startsWith(prefix))) {
      const relative = file.path.slice(prefix.length)
      const [name, ...children] = relative.split('/')
      if (children.length && !entries.has(name!)) {
        entries.set(name!, { mode: '40000', id: await tree(`${prefix}${name}/`) })
      } else if (!children.length) entries.set(name!, { mode: file.mode.toString(8), id: file.id })
    }
    const ordered = [...entries].sort(([a, av], [b, bv]) =>
      Buffer.compare(Buffer.from(a + (av.mode === '40000' ? '/' : '')), Buffer.from(b + (bv.mode === '40000' ? '/' : ''))))
    return object('tree', Buffer.concat(ordered.flatMap(([name, entry]) =>
      [Buffer.from(`${entry.mode} ${name}\0`), Buffer.from(entry.id, 'hex')])))
  }
  const generatedCommit = await object('commit', Buffer.from(`tree ${await tree('')}\n`
    + 'author Foreman Code <qualification@graphql.invalid> 0 +0000\n'
    + 'committer Foreman Code <qualification@graphql.invalid> 0 +0000\n\nApproved verification snapshot\n'))
  const config = Buffer.from('[core]\nrepositoryformatversion = ' + (format === 'sha256' ? '1' : '0')
    + `\nbare = false\nworktree = ${sourceRoot}\n`
    + (format === 'sha256' ? '[extensions]\nobjectformat = sha256\n' : ''))
  await writeFile(join(gitDirectory, 'HEAD'), `${generatedCommit}\n`, { mode: 0o600, flag: 'wx' })
  await writeFile(join(gitDirectory, 'config'), config, { mode: 0o600, flag: 'wx' })
  const header = Buffer.alloc(12)
  header.write('DIRC')
  header.writeUInt32BE(2, 4)
  header.writeUInt32BE(files.length, 8)
  const indexEntries = files.map(file => {
    const id = Buffer.from(file.id, 'hex')
    const name = Buffer.from(file.path)
    const length = 40 + id.length + 2 + name.length + 1
    const entry = Buffer.alloc(Math.ceil(length / 8) * 8)
    entry.writeUInt32BE(file.mode, 24)
    entry.writeUInt32BE(file.size, 36)
    id.copy(entry, 40)
    entry.writeUInt16BE(Math.min(name.length, 0xfff), 40 + id.length)
    name.copy(entry, 42 + id.length)
    return entry
  })
  const indexContent = Buffer.concat([header, ...indexEntries])
  const index = Buffer.concat([indexContent, createHash(format).update(indexContent).digest()])
  await writeFile(join(gitDirectory, 'index'), index, { mode: 0o600, flag: 'wx' })
  const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
  const privateGit = JobVerificationPrivateGitSchema.parse({ sourceCommit: manifest.git.commit, generatedCommit,
    configDigest: digest(config), indexDigest: digest(index),
    repositoryReceiptDigest: digest(Buffer.from(JSON.stringify({ generatedCommit, manifestDigest: manifest.manifestDigest }))) })
  return { sourceRoot, gitDirectory, schedulerDirectory, privateGit }
}

export async function restoreVerificationQualificationSource(input: {
  directory: string; sourceRoot: string; manifest: SourceManifest; signal: AbortSignal
}) {
  const original = await openPrivateRoot(input.directory)
  const destination = await openPrivateRoot(input.sourceRoot)
  try {
    await verifyMaterializedSourceTree(original, input.manifest, input.signal)
    for (const entry of input.manifest.entries) {
      input.signal.throwIfAborted()
      const source = await entryParent(original, entry.path, false)
      const target = await entryParent(destination, entry.path, true)
      try {
        const sourceFile = await open(anchored(source.parent, source.leaf), constants.O_RDONLY | constants.O_NOFOLLOW)
        let bytes: Buffer
        try { bytes = await sourceFile.readFile({ signal: input.signal }) } finally { await sourceFile.close() }
        verifySourceBytes(entry, bytes)
        const file = await open(anchored(target.parent, target.leaf),
          constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
        try {
          const stat = await file.stat()
          if (!stat.isFile() || stat.nlink !== 1) throw new Error('Qualification source file is not private and regular.')
          await file.truncate(0)
          await file.writeFile(bytes, { signal: input.signal })
          await file.chmod(entry.executable ? 0o700 : 0o600)
        } finally { await file.close() }
      } finally { await source.parent.close(); await target.parent.close() }
    }
    return { filesystem: await identity(destination), verifiedAt: new Date().toISOString() }
  } finally { await original.close(); await destination.close() }
}
