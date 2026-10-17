import type { Scenario } from '../../scenario.js'
import { httpCoverage } from '../smoke/support.js'
import { assertDocxAppend, assertPdfAppend } from './documentReaders.js'
import { assertImageTransform } from './imageReader.js'
import { editConversationFile } from './nativeEdit.js'

const files = '/api/operator/conversations/:conversationId/files'
const fileClaims = [
  httpCoverage('POST', `${files}/uploads`, 'success'),
  httpCoverage('PUT', `${files}/uploads/:requestId`, 'success'),
  httpCoverage('POST', `${files}/uploads/:requestId/finalize`, 'success'),
  httpCoverage('GET', files, 'success'),
  httpCoverage('GET', `${files}/:fileId/revisions/:revisionId/content`, 'success'),
]

const imageCases = [
  { filename: 'sample.png', outputFilename: 'resized.png', format: 'png', pages: 1, group: 'image-resize' },
  { filename: 'animated.gif', outputFilename: 'resized.gif', format: 'gif', pages: 2, group: 'animated-gif' },
  { filename: 'animated.webp', outputFilename: 'resized.webp', format: 'webp', pages: 2, group: 'animated-webp' },
] as const

export const codecEditScenarios: Scenario[] = [
  ...imageCases.map((fixture): Scenario => ({
    id: `codec.${fixture.group}-native-edit`,
    title: `Native ${fixture.format} resize preserves image content and immutable source bytes`,
    lane: 'A2', timeoutMs: 120_000,
    covers: [{ surface: 'codec', name: fixture.group, case: 'success' }, ...fileClaims],
    async run(ctx) {
      await editConversationFile(ctx, { filename: fixture.filename, outputFilename: fixture.outputFilename,
        title: `Conformance ${fixture.format} image resize`, edit: { kind: 'resize_image', width: 4, height: 3 },
        async verify(original, output) {
          await assertImageTransform(original.bytes, output, { format: fixture.format, width: 4, height: 3,
            pages: fixture.pages, preserveAnimation: fixture.pages > 1 })
        },
      })
    },
  })),
  {
    id: 'codec.pdf-native-read-append',
    title: 'Native PDF read and append preserve the original page and publish the complete appended page',
    lane: 'A2', timeoutMs: 120_000,
    covers: [{ surface: 'codec', name: 'pdf-read', case: 'success' },
      { surface: 'codec', name: 'pdf-append', case: 'success' }, ...fileClaims],
    async run(ctx) {
      const appended = 'Appended conformance page.'
      await editConversationFile(ctx, { filename: 'original.pdf', outputFilename: 'appended.pdf',
        title: 'Conformance PDF read and append', edit: { kind: 'append_text', text: appended },
        async verify(original, output) { await assertPdfAppend(original.bytes, output, appended) },
      })
    },
  },
  {
    id: 'codec.docx-native-read-edit',
    title: 'Native DOCX edit appends one paragraph and preserves every other package part',
    lane: 'A2', timeoutMs: 120_000,
    covers: [{ surface: 'codec', name: 'docx-read', case: 'success' },
      { surface: 'codec', name: 'docx-edit', case: 'success' }, ...fileClaims],
    async run(ctx) {
      const appended = 'Appended conformance paragraph.'
      await editConversationFile(ctx, { filename: 'original.docx', outputFilename: 'edited.docx',
        title: 'Conformance DOCX read and edit', edit: { kind: 'append_text', text: appended },
        async verify(original, output, context) { await assertDocxAppend(context, original.bytes, output, appended) },
      })
    },
  },
]
