import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { FileMediaType } from '@foreman-code/contracts/files'

const mediaTypes = {
  'sample.png': 'image/png',
  'oriented.jpg': 'image/jpeg',
  'animated.gif': 'image/gif',
  'animated.webp': 'image/webp',
  'original.pdf': 'application/pdf',
  'original.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
} as const satisfies Record<string, FileMediaType>

export type CodecFixtureName = keyof typeof mediaTypes

export function bytesSha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export async function readCodecFixture(filename: CodecFixtureName) {
  const root = new URL('../../../fixtures/codecs/', import.meta.url)
  const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8')) as {
    files: { filename: string; bytes: number; sha256: string }[]
  }
  const entry = manifest.files.find(item => item.filename === filename)
  assert.ok(entry, 'The committed fixture must have an exact input checksum')
  const bytes = await readFile(new URL(filename, root))
  assert.equal(bytes.byteLength, entry.bytes)
  assert.equal(bytesSha256(bytes), entry.sha256)
  return { filename, mediaType: mediaTypes[filename], bytes, sha256: entry.sha256 }
}

export type CodecFixture = Awaited<ReturnType<typeof readCodecFixture>>
