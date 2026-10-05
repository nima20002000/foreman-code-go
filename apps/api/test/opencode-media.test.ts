import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { it } from 'vitest'
import { MAX_FILE_BYTES, MAX_MESSAGE_ATTACHMENTS } from '@foreman-code/contracts/files'
import {
  createOpenCodeBoundFetch, OPENCODE_HTTP_BODY_LIMIT, OpenCodeResponseTooLargeError, readOpenCodeResponseText,
} from '../src/modules/harnesses/opencodeClient.js'
import { openCodeMediaStream } from '../src/modules/harnesses/opencodeMedia.js'
import { object, type OpenCodeMessage } from '../src/modules/harnesses/opencodeProtocol.js'

function chunksResponse(chunks: Iterable<string | Uint8Array>, onCancel?: () => void): Response {
  const iterator = chunks[Symbol.iterator]()
  const encoder = new TextEncoder()
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = iterator.next()
      if (chunk.done) controller.close()
      else controller.enqueue(typeof chunk.value === 'string' ? encoder.encode(chunk.value) : chunk.value)
    },
    cancel() { onCancel?.() },
  }))
}

async function project(chunks: Iterable<string | Uint8Array>): Promise<unknown> {
  const response = chunksResponse(chunks)
  const projected = new Response(response.body!.pipeThrough(openCodeMediaStream()))
  return JSON.parse(await readOpenCodeResponseText(projected)) as unknown
}

function mediaUrl(value: string): string {
  return `urn:opencode:media:sha256:${createHash('sha256').update(value).digest('hex')}`
}

it('streams a single prompt with the full accepted attachment count and size into bounded media identities', async () => {
  const prefix = 'data:image/png;base64,'
  const segment = 'A'.repeat(65_536)
  const encodedSize = 4 * Math.ceil(MAX_FILE_BYTES / 3)
  const padding = (3 - MAX_FILE_BYTES % 3) % 3
  function* image() {
    let remaining = encodedSize - padding
    while (remaining > 0) {
      const chunk = segment.slice(0, Math.min(segment.length, remaining))
      remaining -= chunk.length
      yield chunk
    }
    yield '='.repeat(padding)
  }
  // Compute one identity; every attachment carries the same bytes with its own native part ID.
  const hash = createHash('sha256').update(prefix)
  for (const chunk of image()) hash.update(chunk)
  const expected = `urn:opencode:media:sha256:${hash.digest('hex')}`
  function* message() {
    yield '{"info":{"id":"root","sessionID":"owned","role":"user"},"parts":['
    for (let index = 0; index < MAX_MESSAGE_ATTACHMENTS; index += 1) {
      if (index) yield ','
      yield `{"id":"part-${index}","url":"${prefix}`
      yield* image()
      yield '","filename":"photo.png","mime":"image/png","type":"file"}'
    }
    yield ']}'
  }
  const result = object(await project(message()))
  const parts = result.parts as Record<string, unknown>[]
  assert.equal(parts.length, MAX_MESSAGE_ATTACHMENTS)
  for (const [index, part] of parts.entries()) {
    assert.equal(part.id, `part-${index}`)
    assert.equal(part.url, expected)
    assert.equal(part.filename, 'photo.png')
    assert.equal(part.mime, 'image/png')
  }
  assert(Buffer.byteLength(JSON.stringify(result)) < 10_000)
}, 30_000)

it('preserves JSON and UTF-8 boundaries, escaped URL characters, and media identity across history shapes', async () => {
  const url = 'data:image/png;base64,QQ=='
  const part = { url, type: 'file', mime: 'image/png', filename: 'عکس.png' }
  const message: OpenCodeMessage = { info: { id: 'root', sessionID: 'owned' }, parts: [part,
    { type: 'tool', state: { status: 'completed', attachments: [part], input: { url } } },
    { type: 'text', text: `Quoted "text" and media ${url}` },
  ] }
  const serialized = JSON.stringify([message]).replaceAll('data:', '\\u0064ata:').replaceAll('image/', 'image\\/')
  const bytes = new TextEncoder().encode(serialized)
  const result = await project(Array.from(bytes, byte => Uint8Array.of(byte)))
  const expected = structuredClone([message])
  Object.assign(expected[0]!.parts[0]!, { url: mediaUrl(url) })
  const state = object(expected[0]!.parts[1]!.state)
  Object.assign((state.attachments as typeof part[])[0]!, { url: mediaUrl(url) })
  assert.deepEqual(result, expected)
  assert.deepEqual(await project([JSON.stringify(message)]), expected[0])
  assert.notEqual(mediaUrl(url), mediaUrl('data:image/png;base64,Qg=='))
})

it('preserves file and remote URLs and only projects inline media in native attachment fields', async () => {
  const value = { info: {}, parts: [
    { type: 'file', url: 'file:///isolated/photo.png' },
    { type: 'file', url: 'https://example.test/photo.png' },
    { type: 'file', url: 'data:text/plain,hello' },
    { type: 'tool', state: { input: { url: 'data:image/png;base64,QQ==' } } },
  ] }
  assert.deepEqual(await project([JSON.stringify(value)]), value)
})

it('keeps native prompt media intact and projects only successful history reads', async () => {
  const url = 'data:image/png;base64,QQ=='
  const body = JSON.stringify({ parts: [{ type: 'file', mime: 'image/png', url }] })
  let dispatched = ''
  const fetch = createOpenCodeBoundFetch({ ownerAgentId: 'owner', directory: '/isolated', generation: 1,
    server: { generation: 1, ownerAgentId: 'owner', expectedVersion: '1.18.31',
      ensure: async () => {}, dispose: async () => {}, request: async (_path, init) => {
        dispatched = String(init?.body)
        return new Response(body, { headers: { 'content-type': 'application/json' } })
      } },
  })
  const response = await fetch('http://opencode.invalid/session/owned/prompt_async?directory=%2Fisolated', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  })
  assert.equal(dispatched, body)
  assert.equal(await readOpenCodeResponseText(response), body)
})

for (const suffix of ['\\q"}]}', ' !"}]}', '\\u0000"}]}', 'AAAA']) {
  it(`rejects incomplete or invalid JSON inside projected media (${JSON.stringify(suffix)})`, async () => {
    await assert.rejects(project(['{"parts":[{"url":"data:image/png;base64,', suffix]))
  })
}

it('retains the metadata buffer limit and cancels a page with oversized non-media content', async () => {
  let canceled = false
  function* page() {
    yield '{"parts":[{"type":"text","text":"'
    for (let size = 0; size <= OPENCODE_HTTP_BODY_LIMIT; size += 65_536) yield 'x'.repeat(65_536)
    yield '"}]}'
  }
  const response = chunksResponse(page(), () => { canceled = true })
  const projected = new Response(response.body!.pipeThrough(openCodeMediaStream()))
  await assert.rejects(readOpenCodeResponseText(projected), OpenCodeResponseTooLargeError)
  // Pipe cancellation is asynchronous and is driven by the bounded reader.
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(canceled, true)
})

it('cancels an owned history stream while an inline image is still being read', async () => {
  const owner = new AbortController()
  let started!: () => void
  const reading = new Promise<void>(resolve => { started = resolve })
  let canceled = false
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"parts":[{"url":"data:image/png;base64,AAAA'))
    },
    pull() { started() },
    cancel() { canceled = true },
  }))
  const fetch = createOpenCodeBoundFetch({ ownerAgentId: 'owner', directory: '/isolated', generation: 1,
    ownerSignal: owner.signal, server: { generation: 1, ownerAgentId: 'owner', expectedVersion: '1.18.31',
      ensure: async () => {}, dispose: async () => {}, request: async () => response },
  })
  const bound = await fetch('http://opencode.invalid/session/owned/message/root?directory=%2Fisolated')
  const pending = readOpenCodeResponseText(bound, owner.signal)
  await reading
  const reason = new Error('Native history owner closed.')
  owner.abort(reason)
  await assert.rejects(pending, { message: reason.message })
  assert.equal(canceled, true)
  assert.equal(response.body!.locked, false)
})
