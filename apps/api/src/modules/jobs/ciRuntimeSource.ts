import { createReadStream } from 'node:fs'
import { mkdtemp, open, rm, writeFile, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'
import type { CiRuntimeRequest } from '@foreman-code/contracts'
import type { GitWorktreePorts } from '../sources/gitWorktree.js'
import { importGitSourceObjects } from '../sources/gitSourceObjects.js'
import { VerifiedSourcePackageReader } from '../sources/operationPackage.js'
import { SourceError } from '../sources/manifest.js'

type SourceRequest = Extract<CiRuntimeRequest, { operation: 'source' }>
type Selection = Pick<SourceRequest, 'transferId' | 'repository' | 'source' | 'byteSize' | 'sha256'>

/** Bounded source packages use the existing authenticated CI channel, without caller-selected paths. */
export class CiRuntimeSourceReceiver {
  private receiving = false
  private upload: { selection: Selection; directory: string; file: FileHandle; offset: number;
    hash: ReturnType<typeof createHash>; timer: ReturnType<typeof setTimeout> } | undefined

  constructor(private readonly git: GitWorktreePorts, private readonly signal: AbortSignal) {
    signal.addEventListener('abort', () => { void this.close().catch(error => console.error(error)) }, { once: true })
  }

  get active(): boolean { return !!this.upload || this.receiving }

  async receive(request: SourceRequest): Promise<void> {
    if (this.receiving) throw new SourceError('SOURCE_CAPACITY', 'A CI source chunk is already being processed.')
    this.receiving = true
    try {
      await this.receiveChunk(request)
    } finally {
      this.receiving = false
    }
  }

  private async receiveChunk(request: SourceRequest): Promise<void> {
    this.signal.throwIfAborted()
    const { transferId, repository, source, byteSize, sha256 } = request
    const selection = { transferId, repository, source, byteSize, sha256 }
    const bytes = Buffer.from(request.dataBase64, 'base64')
    if (bytes.toString('base64') !== request.dataBase64 || !bytes.length || bytes.length > 512 * 1024) {
      throw new SourceError('SOURCE_PACKAGE_INVALID', 'Invalid CI source chunk.')
    }
    if (!this.upload) {
      if (request.offset !== 0) throw new SourceError('SOURCE_PACKAGE_INVALID', 'Start the CI source package at offset zero.')
      const directory = await mkdtemp(join(tmpdir(), 'foreman-ci-source-'))
      const file = await open(join(directory, 'source'), 'wx', 0o600)
      const timer = setTimeout(() => { void this.close().catch(error => console.error(error)) }, 5 * 60_000)
      timer.unref()
      this.upload = { selection, directory, file, offset: 0, hash: createHash('sha256'), timer }
    }
    const upload = this.upload
    if (!isDeepStrictEqual(upload.selection, selection)) {
      throw new SourceError('SOURCE_PACKAGE_INVALID', 'Another CI source transfer owns this receiver.')
    }
    try {
      if (request.offset !== upload.offset || upload.offset + bytes.length > byteSize) {
        throw new SourceError('SOURCE_PACKAGE_INVALID', 'CI source chunks must cover the approved package in order.')
      }
      await upload.file.writeFile(bytes)
      upload.hash.update(bytes)
      upload.offset += bytes.length
      upload.timer.refresh()
      if (!request.complete) return
      if (upload.offset !== byteSize || upload.hash.digest('hex') !== sha256) {
        throw new SourceError('SOURCE_BYTES_INVALID', 'The CI source package differs from its approved transfer.')
      }
      await upload.file.close()
      await this.importSource(upload.directory, upload.selection)
      await this.close()
    } catch (error) {
      await this.close()
      throw error
    }
  }

  private async importSource(directory: string, selection: Selection): Promise<void> {
    const reader = new VerifiedSourcePackageReader(createReadStream(join(directory, 'source'),
      { highWaterMark: 1024 * 1024 }), selection.byteSize, this.signal)
    try {
      const manifest = await reader.open(selection.source)
      if (manifest.git?.repository !== selection.repository) {
        throw new SourceError('SOURCE_PIN_CONFLICT', 'CI source delivery must use the approved repository.')
      }
      const paths = new Map<string, string>()
      for (const [index, entry] of manifest.entries.entries()) {
        const path = join(directory, `blob-${index}`)
        await writeFile(path, await reader.read(manifest, entry, this.signal), { mode: 0o600 })
        paths.set(entry.path, path)
      }
      const metadata = await reader.readGitMetadata(manifest, this.signal)
      await reader.complete()
      await importGitSourceObjects({ ports: this.git, repository: selection.repository, manifest, metadata, signal: this.signal,
        blobPath: async path => paths.get(path)! })
    } finally {
      reader.close()
    }
  }

  private async close(): Promise<void> {
    const upload = this.upload
    if (!upload) return
    this.upload = undefined
    clearTimeout(upload.timer)
    await upload.file.close()
    await rm(upload.directory, { recursive: true, force: true })
  }
}
