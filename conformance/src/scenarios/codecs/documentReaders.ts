import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { getResolvedPDFJS } from 'unpdf'
import type { ScenarioContext } from '../../scenario.js'

const execute = promisify(execFile)
const wordNamespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

interface XmlNode {
  tag: string
  attributes: Record<string, string>
  text: string | null
  tail: string | null
  children: XmlNode[]
}

interface DocxInspection {
  parts: { name: string; contentBase64: string }[]
  document: XmlNode
}

function element(name: string, children: XmlNode[] = [], text: string | null = null,
  attributes: Record<string, string> = {}): XmlNode {
  return { tag: `{${wordNamespace}}${name}`, attributes, text, tail: null, children }
}

function paragraph(text: string, appended: boolean) {
  const attributes: Record<string, string> = appended
    ? { '{http://www.w3.org/XML/1998/namespace}space': 'preserve' } : {}
  return element('p', [element('r', [element('t', [], text, attributes)])])
}

function documentTree(appended?: string) {
  const paragraphs = [paragraph('Original conformance paragraph.', false)]
  if (appended !== undefined) paragraphs.push(paragraph(appended, true))
  return element('document', [element('body', [
    ...paragraphs,
    element('sectPr', [element('pgSz', [], null,
      { [`{${wordNamespace}}w`]: '12240', [`{${wordNamespace}}h`]: '15840' })]),
  ])])
}

async function readDocx(ctx: ScenarioContext, bytes: Uint8Array): Promise<DocxInspection> {
  assert.ok(bytes.byteLength <= 1_048_576)
  const directory = await mkdtemp(join(ctx.scenarioDirectory, 'document-reader-'))
  const path = join(directory, 'downloaded.docx')
  try {
    await writeFile(path, bytes, { mode: 0o600 })
    const reader = fileURLToPath(new URL('../../../fixtures/codecs/read-docx.py', import.meta.url))
    const result = await execute('python3', [reader, path], {
      encoding: 'utf8', maxBuffer: 4_194_304, timeout: 10_000, signal: ctx.signal,
      env: ctx.target.environment, cwd: directory,
    })
    assert.equal(result.stderr, '', 'The independent DOCX reader must not hide parser diagnostics')
    return JSON.parse(result.stdout) as DocxInspection
  } finally { await rm(directory, { recursive: true, force: true }) }
}

/** Compare every package part; only document.xml may acquire the requested paragraph. */
export async function assertDocxAppend(ctx: ScenarioContext, original: Uint8Array, output: Uint8Array, appended: string) {
  const before = await readDocx(ctx, original)
  const after = await readDocx(ctx, output)
  assert.deepStrictEqual(before.document, documentTree())
  const partNames = ['[Content_Types].xml', '_rels/.rels', 'docProps/custom.xml', 'word/document.xml', 'word/styles.xml']
  assert.deepStrictEqual(before.parts.map(part => part.name), partNames)
  assert.deepStrictEqual(after.parts.map(part => part.name), partNames)
  for (const part of before.parts) {
    if (part.name === 'word/document.xml') continue
    assert.deepStrictEqual(after.parts.find(candidate => candidate.name === part.name), part)
  }
  assert.deepStrictEqual(after.document, documentTree(appended))
  const changed = after.parts.find(part => part.name === 'word/document.xml')!
  assert.notEqual(changed.contentBase64, before.parts.find(part => part.name === changed.name)!.contentBase64)
}

async function readPdf(bytes: Uint8Array) {
  assert.ok(bytes.byteLength <= 1_048_576)
  const { getDocument } = await getResolvedPDFJS()
  const task = getDocument({ data: Uint8Array.from(bytes), isEvalSupported: false, useWasm: false,
    useWorkerFetch: false, useSystemFonts: true, disableFontFace: true, verbosity: 0 })
  try {
    const document = await task.promise
    assert.ok(document.numPages >= 1 && document.numPages <= 4)
    assert.equal(await document.getPermissions(), null)
    const pages = []
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number)
      try {
        const viewport = page.getViewport({ scale: 1 })
        const content = await page.getTextContent({ includeMarkedContent: false })
        let text = ''
        for (const item of content.items) {
          if ('str' in item) text += `${item.str}${item.hasEOL ? '\n' : ' '}`
        }
        assert.ok(text.length <= 8192)
        pages.push({ number, width: viewport.width, height: viewport.height, text: text.trimEnd() })
      } finally { page.cleanup() }
    }
    return pages
  } finally { await task.destroy() }
}

export async function assertPdfAppend(original: Uint8Array, output: Uint8Array, appended: string) {
  const first = { number: 1, width: 612, height: 792, text: 'Original conformance page.' }
  assert.deepStrictEqual(await readPdf(original), [first])
  assert.deepStrictEqual(await readPdf(output), [first, { number: 2, width: 612, height: 792, text: appended }])
}
