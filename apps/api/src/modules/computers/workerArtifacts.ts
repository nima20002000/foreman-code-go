import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  WORKER_UPDATE_MAX_BINARY_BYTES, WORKER_UPDATE_MAX_JSON_BYTES, WORKER_UPDATE_NAMESPACE, WORKER_UPDATE_VERSION,
  WorkerArtifactIndexSchema, WorkerArtifactManifestSchema, WorkerArtifactRequestSchema,
  type WorkerArtifactManifest, type WorkerArtifactTarget,
} from '@foreman-code/contracts/computer-maintenance'
import { DeviceApplicationError } from '../devices/deviceApplicationError.js'
import type { DeviceExtensionRegistration } from '../devices/deviceApplicationChannel.js'

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
type ArtifactFile = WorkerArtifactManifest['files'][number]
interface VerifiedFile { identity: string; verification: Promise<void> }

function fileIdentity(info: BigIntStats) {
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':')
}

function sameTarget(left: WorkerArtifactTarget, right: WorkerArtifactTarget) {
  return left.os === right.os && left.osRelease === right.osRelease && left.arch === right.arch
    && left.libc === right.libc && left.node === right.node
}

async function openArtifactFile(root: string, path: string) {
  const source = join(root, path)
  const parent = await realpath(dirname(source))
  if (parent !== root && !parent.startsWith(`${root}/`)) throw new DeviceApplicationError('extension-rejected')
  return open(source, constants.O_RDONLY | constants.O_NOFOLLOW)
}

async function readRegularFile(root: string, path: string, maximum: number) {
  const file = await openArtifactFile(root, path)
  try {
    const info = await file.stat({ bigint: true })
    if (!info.isFile() || info.size > BigInt(maximum)) throw new DeviceApplicationError('extension-rejected')
    const bytes = await file.readFile()
    const after = await file.stat({ bigint: true })
    if (BigInt(bytes.byteLength) !== info.size || fileIdentity(info) !== fileIdentity(after)) {
      throw new DeviceApplicationError('extension-rejected')
    }
    return bytes
  } finally {
    await file.close()
  }
}

async function verifyArtifactFile(handle: FileHandle, file: ArtifactFile, identity: string) {
  const hash = createHash('sha256')
  const buffer = Buffer.alloc(Math.min(file.size, WORKER_UPDATE_MAX_BINARY_BYTES))
  let position = 0
  while (position < file.size) {
    const length = Math.min(buffer.length, file.size - position)
    const { bytesRead } = await handle.read(buffer, 0, length, position)
    if (bytesRead === 0) throw new DeviceApplicationError('extension-rejected')
    hash.update(buffer.subarray(0, bytesRead))
    position += bytesRead
  }
  const after = await handle.stat({ bigint: true })
  if (fileIdentity(after) !== identity || hash.digest('hex') !== file.sha256) {
    throw new DeviceApplicationError('extension-rejected')
  }
}

async function readArtifactChunk(directory: string, file: ArtifactFile, offset: number,
  verifiedFiles: Map<string, VerifiedFile>) {
  if (offset > file.size) throw new DeviceApplicationError('extension-rejected')
  const handle = await openArtifactFile(directory, file.path)
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.size !== BigInt(file.size)) throw new DeviceApplicationError('extension-rejected')
    const identity = fileIdentity(before)
    const key = join(directory, file.path)
    let cached = verifiedFiles.get(key)
    if (!cached || cached.identity !== identity) {
      cached = { identity, verification: verifyArtifactFile(handle, file, identity) }
      verifiedFiles.set(key, cached)
    }
    try {
      await cached.verification
    } catch (error) {
      if (verifiedFiles.get(key) === cached) verifiedFiles.delete(key)
      throw error
    }
    if (fileIdentity(await handle.stat({ bigint: true })) !== identity) {
      throw new DeviceApplicationError('extension-rejected')
    }
    const bytes = Buffer.alloc(Math.min(file.size - offset, WORKER_UPDATE_MAX_BINARY_BYTES))
    let received = 0
    while (received < bytes.length) {
      const { bytesRead } = await handle.read(bytes, received, bytes.length - received, offset + received)
      if (bytesRead === 0) throw new DeviceApplicationError('extension-rejected')
      received += bytesRead
    }
    if (fileIdentity(await handle.stat({ bigint: true })) !== identity) {
      throw new DeviceApplicationError('extension-rejected')
    }
    return bytes
  } finally {
    await handle.close()
  }
}

async function artifactIndex(directory: string, version: string) {
  const info = await lstat(directory)
  if (!info.isDirectory() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) {
    throw new DeviceApplicationError('extension-rejected')
  }
  const root = await realpath(directory)
  const bytes = await readRegularFile(root, 'index.json', WORKER_UPDATE_MAX_JSON_BYTES)
  const index = WorkerArtifactIndexSchema.parse(JSON.parse(bytes.toString('utf8')))
  if (index.version !== version) throw new DeviceApplicationError('extension-rejected')
  return { root, index }
}

async function artifactManifest(root: string, manifestSha256: string, version: string) {
  const directory = join(root, manifestSha256)
  if (!(await lstat(directory)).isDirectory()) throw new DeviceApplicationError('extension-rejected')
  const bytes = await readRegularFile(directory, 'manifest.json', WORKER_UPDATE_MAX_JSON_BYTES)
  if (sha256(bytes) !== manifestSha256) throw new DeviceApplicationError('extension-rejected')
  const value: unknown = JSON.parse(bytes.toString('utf8'))
  const parsed = WorkerArtifactManifestSchema.parse(value)
  if (parsed.version !== version || !bytes.equals(Buffer.from(`${JSON.stringify(value, null, 2)}\n`))) {
    throw new DeviceApplicationError('extension-rejected')
  }
  const manifest = value as WorkerArtifactManifest
  return { directory, manifest, bytes }
}

/** Registered only on the paired, authenticated device channel. */
export function createWorkerArtifactExtension(options: { directory: string; version: string }): DeviceExtensionRegistration {
  const verifiedFiles = new Map<string, VerifiedFile>()
  return {
    namespace: WORKER_UPDATE_NAMESPACE,
    version: WORKER_UPDATE_VERSION,
    role: 'server',
    maxJsonBytes: WORKER_UPDATE_MAX_JSON_BYTES,
    maxBinaryBytes: WORKER_UPDATE_MAX_BINARY_BYTES,
    async handle(raw, context) {
      context.signal.throwIfAborted()
      if (context.bytes?.byteLength) throw new DeviceApplicationError('extension-rejected')
      const request = WorkerArtifactRequestSchema.parse(raw)
      const { root, index } = await artifactIndex(options.directory, options.version)
      const artifact = request.operation === 'release'
        ? index.artifacts.find(entry => sameTarget(entry.target, request.target))
        : index.artifacts.find(entry => entry.manifestSha256 === request.manifestSha256)
      if (!artifact) {
        if (request.operation === 'release') return { payload: { operation: 'release', release: null } }
        throw new DeviceApplicationError('extension-rejected')
      }
      const { directory, manifest, bytes: manifestBytes } = await artifactManifest(
        root, artifact.manifestSha256, options.version,
      )
      if (!sameTarget(manifest.target, artifact.target)) throw new DeviceApplicationError('extension-rejected')
      if (request.operation === 'release') {
        return { payload: { operation: 'release', release: {
          version: options.version, manifestSha256: artifact.manifestSha256, manifest,
          ...(index.github ? { github: index.github } : {}),
        } } }
      }
      const file = manifest.files.find(entry => entry.path === request.path)
      if (!file && request.path !== 'manifest.json') throw new DeviceApplicationError('extension-rejected')
      if (!file && request.offset > manifestBytes.length) throw new DeviceApplicationError('extension-rejected')
      const bytes = file
        ? await readArtifactChunk(directory, file, request.offset, verifiedFiles)
        : manifestBytes.subarray(request.offset, request.offset + WORKER_UPDATE_MAX_BINARY_BYTES)
      context.signal.throwIfAborted()
      return { payload: { ...request, byteSize: bytes.byteLength }, bytes }
    },
  }
}
