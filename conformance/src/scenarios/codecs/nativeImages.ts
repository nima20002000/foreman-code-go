import assert from 'node:assert/strict'
import { z } from 'zod'
import { assertJson } from '../../assertions.js'
import type { Scenario } from '../../scenario.js'
import { createConversation } from '../smoke/conversations.js'
import { sendOperatorTurn } from '../streams/operatorTurn.js'
import { installCodexScripts } from '../workflows/codexScript.js'
import { downloadConversationFile, uploadConversationFile } from './files.js'
import { bytesSha256, readCodecFixture } from './fixtures.js'
import { assertImageTransform } from './imageReader.js'

// This is a fixture observation envelope, not an application domain model.
const NativeImagesSchema = z.array(z.object({
  type: z.literal('localImage'), mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  width: z.number().int().positive(), height: z.number().int().positive(), pages: z.number().int().positive(),
  orientation: z.number().int().nullable(), byteLength: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), contentBase64: z.string().max(1_048_576),
}).strict()).length(1)

const nativeInputs = [
  { filename: 'sample.png', format: 'png', mediaType: 'image/png', width: 8, height: 6, unchanged: true },
  { filename: 'oriented.jpg', format: 'png', mediaType: 'image/png', width: 6, height: 8, unchanged: false },
  { filename: 'animated.gif', format: 'png', mediaType: 'image/png', width: 8, height: 6, unchanged: false },
  { filename: 'animated.webp', format: 'png', mediaType: 'image/png', width: 8, height: 6, unchanged: false },
] as const

export const nativeImageScenarios: Scenario[] = nativeInputs.map((fixture): Scenario => ({
  id: `codec.native-image-${fixture.filename.replace('.', '-')}`,
  title: `Native delivery of ${fixture.filename} preserves pixels in display orientation`,
  lane: 'A2', timeoutMs: 120_000,
  covers: fixture.filename === 'oriented.jpg' ? [{ surface: 'codec', name: 'image-rotate', case: 'success' }] : [],
  async run(ctx) {
    const original = await readCodecFixture(fixture.filename)
    const title = `Conformance native image delivery ${fixture.filename}`
    const { conversation } = await createConversation(ctx, title)
    const uploaded = await uploadConversationFile(ctx, conversation.id, original)
    await installCodexScripts(ctx, [{ id: 'native-image-input', includes: title,
      turns: [{ answerFromInput: 'images' }] }])
    await sendOperatorTurn(ctx, conversation, { content: title, attachments: [uploaded.ref], inputFiles: [uploaded.value],
      async assertAnswer(text) {
        const raw: unknown = JSON.parse(text)
        const [input] = NativeImagesSchema.parse(raw)
        assert.ok(input)
        const bytes = Buffer.from(input.contentBase64, 'base64')
        assert.equal(bytes.toString('base64'), input.contentBase64)
        await assertImageTransform(original.bytes, bytes, { format: fixture.format, width: fixture.width,
          height: fixture.height, pages: 1, preserveAnimation: false })
        assertJson(raw, [{ type: 'localImage', mediaType: fixture.mediaType, width: fixture.width,
          height: fixture.height, pages: 1, orientation: null, byteLength: bytes.byteLength,
          sha256: bytesSha256(bytes), contentBase64: bytes.toString('base64') }])
        if (fixture.unchanged) assert.deepStrictEqual(bytes, original.bytes)
        else assert.notDeepStrictEqual(bytes, original.bytes)
        assert.deepStrictEqual(await downloadConversationFile(ctx, conversation.id, uploaded.value), original.bytes)
        return []
      },
    })
  },
}))
