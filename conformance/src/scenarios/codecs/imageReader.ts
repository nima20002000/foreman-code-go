import assert from 'node:assert/strict'
import sharp from 'sharp'

export async function readImageBytes(bytes: Uint8Array) {
  assert.ok(bytes.byteLength <= 1_048_576)
  const input = Buffer.from(bytes)
  const metadata = await sharp(input, { animated: true, limitInputPixels: 1_000_000 }).metadata()
  assert.ok(metadata.width && metadata.height)
  const { data, info } = await sharp(input, { animated: true, limitInputPixels: 1_000_000 })
    .toColourspace('srgb').ensureAlpha().raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true })
  const height = metadata.pageHeight ?? metadata.height
  const pages = metadata.pages ?? 1
  assert.equal(info.channels, 4)
  assert.equal(info.width, metadata.width)
  assert.equal(info.height, height * pages)
  assert.equal(data.byteLength, metadata.width * height * pages * 4)
  return { metadata, data, width: metadata.width, height, pages }
}

interface ImageExpectation {
  format: 'png' | 'jpeg' | 'gif' | 'webp'
  width: number
  height: number
  pages: number
  preserveAnimation: boolean
}

/** Inspect every decoded pixel, frame and timing value without requiring one encoder's output bytes. */
export async function assertImageTransform(original: Uint8Array, output: Uint8Array, expected: ImageExpectation) {
  const before = await readImageBytes(original)
  const after = await readImageBytes(output)
  assert.deepStrictEqual({ format: after.metadata.format, width: after.width, height: after.height,
    pages: after.pages, orientation: after.metadata.orientation ?? null },
  { format: expected.format, width: expected.width, height: expected.height, pages: expected.pages, orientation: null })
  assert.ok([1, 6].includes(before.metadata.orientation ?? 1), 'Fixed input orientations are explicit')
  if (expected.preserveAnimation) {
    assert.equal(after.pages, before.pages)
    assert.deepStrictEqual(after.metadata.delay, before.metadata.delay)
    assert.equal(after.metadata.loop, before.metadata.loop)
  }
  const rotated = before.metadata.orientation === 6
  const displayWidth = rotated ? before.height : before.width
  const displayHeight = rotated ? before.width : before.height
  for (let frame = 0; frame < after.pages; frame++) {
    for (let y = 0; y < after.height; y++) {
      for (let x = 0; x < after.width; x++) {
        const displayX = Math.min(displayWidth - 1, Math.floor((x + 0.5) * displayWidth / after.width))
        const displayY = Math.min(displayHeight - 1, Math.floor((y + 0.5) * displayHeight / after.height))
        const sourceX = rotated ? displayY : displayX
        const sourceY = rotated ? before.height - 1 - displayX : displayY
        const source = ((frame * before.height + sourceY) * before.width + sourceX) * 4
        const target = ((frame * after.height + y) * after.width + x) * 4
        // Resampling and JPEG/WebP quantization can soften the fixed red/blue boundary.
        // This bound still rejects missing frames, wrong rotation, blank images and swapped colors.
        for (let channel = 0; channel < 3; channel++) {
          assert.ok(Math.abs(before.data[source + channel]! - after.data[target + channel]!) <= 64,
            `Changed image content at frame ${frame}, pixel ${x},${y}, channel ${channel}`)
        }
        assert.equal(after.data[target + 3], before.data[source + 3], 'Pixel alpha must be preserved')
      }
    }
  }
  return after
}
