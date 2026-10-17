/* global require, module, Buffer */
/* eslint @typescript-eslint/no-require-imports: "off" -- Inspect actual native fixture input. */
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const MAX_IMAGE_BYTES = 64 * 1024 * 1024

function scope(root) {
  const value = JSON.parse(fs.readFileSync(path.join(root, 'fixture-scope.json'), 'utf8'))
  if (!path.isAbsolute(value.directory) || !path.isAbsolute(value.imageMetadataModule)) {
    throw new Error('Native input inspection requires its isolated fixture scope and pinned image reader.')
  }
  return value
}

function localImageBytes(directory, file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('Native image path must be absolute.')
  const root = fs.realpathSync(directory)
  const source = fs.realpathSync(file)
  const relative = path.relative(root, source)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Native image delivery escaped the isolated fixture scope.')
  }
  const descriptor = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const stat = fs.fstatSync(descriptor)
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) throw new Error('Native image delivery is not a bounded regular file.')
    return fs.readFileSync(descriptor)
  } finally { fs.closeSync(descriptor) }
}

function inlineImageBytes(url) {
  if (typeof url !== 'string') throw new Error('Native inline image has no URL.')
  const match = /^data:image\/(?:png|jpeg|gif|webp);base64,([A-Za-z0-9+/]*={0,2})$/.exec(url)
  if (!match) throw new Error('Native fixture image inspection accepts only delivered inline image bytes.')
  const bytes = Buffer.from(match[1], 'base64')
  if (bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== match[1]) throw new Error('Native inline image is invalid or exceeds its bound.')
  return bytes
}

async function inspectNativeInput(root, input, kind) {
  if (!Array.isArray(input)) throw new Error('Native input is not an array.')
  if (kind === 'text') return input.filter(item => item.type === 'text').map(item => item.text).join('\n')
  if (kind !== 'images') throw new Error('Native input inspection kind is unsupported.')
  const configuration = scope(root)
  const sharp = require(configuration.imageMetadataModule)
  const images = []
  for (const item of input) {
    if (!['image', 'localImage'].includes(item.type)) continue
    const bytes = item.type === 'localImage'
      ? localImageBytes(configuration.directory, item.path) : inlineImageBytes(item.url)
    const metadata = await sharp(bytes, { animated: true, limitInputPixels: 100_000_000 }).metadata()
    const mediaTypes = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }
    if (!mediaTypes[metadata.format] || !metadata.width || !metadata.height) throw new Error('Native image metadata is unavailable.')
    images.push({ type: item.type, mediaType: mediaTypes[metadata.format], width: metadata.width,
      height: metadata.height, pages: metadata.pages ?? 1, orientation: metadata.orientation ?? null,
      byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
      contentBase64: bytes.toString('base64') })
  }
  return JSON.stringify(images)
}

module.exports = { inspectNativeInput }
