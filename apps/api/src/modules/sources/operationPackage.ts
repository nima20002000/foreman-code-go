import { Readable } from 'node:stream'
import { isDeepStrictEqual } from 'node:util'
import type { SourceManifest, SourceEntry } from '@graphql/contracts/source-materialization'
import type { SourceByteReader, SourceSnapshotPin } from './ports.js'
import { SourceError, SOURCE_LIMITS, verifySourceBytes, verifySourceManifest } from './manifest.js'
const MAGIC = Buffer.from('GSRC0001')
export const SOURCE_PACKAGE_MAX_BYTES = 128 * 1024 * 1024
export function sourcePackageHeader(raw: SourceManifest): Buffer {
  const manifest = verifySourceManifest(raw), json = Buffer.from(JSON.stringify(manifest)), header = Buffer.alloc(12)
  MAGIC.copy(header); header.writeUInt32BE(json.byteLength, 8)
  if (12 + json.byteLength + manifest.totalBytes > SOURCE_PACKAGE_MAX_BYTES) throw new SourceError('SOURCE_CAPACITY', 'Source package and metadata exceed the independent source byte budget.')
  return Buffer.concat([header, json])
}
/** One source-class object, no archive extraction or per-file transfer IDs. */
export function sourcePackageStream(manifest: SourceManifest, bytes: SourceByteReader, signal: AbortSignal): Readable {
  const header = sourcePackageHeader(manifest)
  return Readable.from((async function* () {
    for (let offset = 0; offset < header.length; offset += 1024 * 1024) { signal.throwIfAborted(); yield header.subarray(offset, offset + 1024 * 1024) }
    for (const entry of manifest.entries) {
      signal.throwIfAborted(); const data = await bytes.read(manifest, entry, signal); verifySourceBytes(entry, data)
      for (let offset = 0; offset < data.byteLength; offset += 1024 * 1024) { signal.throwIfAborted(); yield data.subarray(offset, offset + 1024 * 1024) }
    }
  })(), { objectMode: false, highWaterMark: 1024 * 1024 })
}
/** Verified B stream is consumed sequentially; one <=16MiB file and <=1MiB chunk
 * are retained. Transfer SHA/size is independently checked by B before this opens.
 */
export class VerifiedSourcePackageReader implements SourceByteReader {
  private readonly iterator: AsyncIterator<unknown>
  private chunk = Buffer.alloc(0)
  private position = 0
  private consumed = 0
  private index = 0
  private completed = false
  private manifest: SourceManifest | undefined
  constructor(private readonly stream: Readable, private readonly byteSize: number, private readonly signal: AbortSignal) {
    if (!Number.isSafeInteger(byteSize) || byteSize < 12 || byteSize > SOURCE_PACKAGE_MAX_BYTES) throw new SourceError('SOURCE_PACKAGE_INVALID', 'Invalid source package size.')
    this.iterator = stream[Symbol.asyncIterator]()
  }
  private async exact(size: number): Promise<Buffer> {
    this.signal.throwIfAborted()
    if (!Number.isSafeInteger(size) || size < 0 || size > SOURCE_LIMITS.fileBytes || this.consumed + size > this.byteSize) throw new SourceError('SOURCE_PACKAGE_INVALID', 'Source package extent exceeds its accepted boundary.')
    const output = Buffer.alloc(size); let offset = 0
    while (offset < size) {
      this.signal.throwIfAborted()
      if (this.position === this.chunk.length) {
        const next = await this.iterator.next()
        if (next.done || !(next.value instanceof Uint8Array) || next.value.byteLength === 0 || next.value.byteLength > 1024 * 1024)
          throw new SourceError('SOURCE_PACKAGE_INVALID', 'Source package is truncated or exceeds its bounded chunk policy.')
        this.chunk = Buffer.from(next.value); this.position = 0
      }
      const count = Math.min(size - offset, this.chunk.length - this.position)
      this.chunk.copy(output, offset, this.position, this.position + count); offset += count; this.position += count
    }
    this.consumed += size; return output
  }
  async open(pin: SourceSnapshotPin): Promise<SourceManifest> {
    const header = await this.exact(12)
    if (!header.subarray(0, 8).equals(MAGIC)) throw new SourceError('SOURCE_PACKAGE_INVALID', 'Unsupported source package format.')
    const size = header.readUInt32BE(8)
    if (size > 2 * 1024 * 1024) throw new SourceError('SOURCE_CAPACITY', 'Source manifest exceeds its metadata budget.')
    const json = await this.exact(size), text = json.toString('utf8')
    if (!Buffer.from(text).equals(json)) throw new SourceError('SOURCE_PACKAGE_INVALID', 'Ambiguous source metadata encoding.')
    const manifest = verifySourceManifest(JSON.parse(text))
    if (manifest.snapshotId !== pin.snapshotId || manifest.approvedSourceId !== pin.approvedSourceId || manifest.manifestDigest !== pin.manifestDigest
      || 12 + size + manifest.totalBytes !== this.byteSize) throw new SourceError('SOURCE_PIN_CONFLICT', 'Source package does not match the accepted exact snapshot and extent.')
    this.manifest = manifest; return manifest
  }
  async read(pin: SourceSnapshotPin, entry: SourceEntry, signal: AbortSignal): Promise<Uint8Array> {
    signal.throwIfAborted()
    if (!this.manifest || pin.snapshotId !== this.manifest.snapshotId || pin.approvedSourceId !== this.manifest.approvedSourceId
      || pin.manifestDigest !== this.manifest.manifestDigest || !isDeepStrictEqual(this.manifest.entries[this.index], entry))
      throw new SourceError('SOURCE_PACKAGE_INVALID', 'Source package entries must follow the exact complete manifest order.')
    const data = await this.exact(entry.byteSize); verifySourceBytes(entry, data); this.index++; return data
  }
  get readyToComplete(): boolean { return !!this.manifest && this.index === this.manifest.entries.length }
  async complete(): Promise<void> {
    if (this.completed) return
    if (!this.manifest || this.index !== this.manifest.entries.length || this.consumed !== this.byteSize || this.position !== this.chunk.length)
      throw new SourceError('SOURCE_PACKAGE_INVALID', 'Source package contains an incomplete or unexpected extent.')
    if (!(await this.iterator.next()).done) throw new SourceError('SOURCE_PACKAGE_INVALID', 'Source package contains trailing bytes.')
    this.completed = true
  }
  close(): void { this.stream.destroy() }
}
