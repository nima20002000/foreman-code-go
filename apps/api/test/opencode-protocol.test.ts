import assert from 'node:assert/strict'
import { it } from 'vitest'

import { credentialReferences, parseConfigObject, parseOpenCodeSse, providerSupports, visibleNativeEvent, object } from '../src/modules/harnesses/opencodeProtocol.js'

it('[F22] credential provenance recognizes Bearer placeholders only in unresolved input', () => {
  assert.deepEqual(credentialReferences({ mcp: { app: { headers: { Authorization: 'Bearer {env:GRAPHQL_APP_MCP_TOKEN}' } } } }), { app: 'GRAPHQL_APP_MCP_TOKEN' })
  assert.deepEqual(credentialReferences({ mcp: { app: { headers: { Authorization: 'Bearer resolved-value' } } } }), {})
})

it('[F20] reasoning part updates and associated deltas are filtered using native identity', () => {
  const types = new Map<string, string>()
  assert.equal(visibleNativeEvent({ type: 'message.part.updated', properties: { part: { id: 'reason', type: 'reasoning', text: 'private' } } }, false, types), false)
  assert.equal(visibleNativeEvent({ type: 'message.part.delta', properties: { partID: 'reason', delta: 'private' } }, false, types), false)
  assert.equal(visibleNativeEvent({ type: 'message.part.delta', properties: { partID: 'unknown-after-gap', delta: 'possibly reasoning' } }, false, types), false)
  assert.equal(visibleNativeEvent({ type: 'message.part.updated', properties: { part: { id: 'text', type: 'text' } } }, false, types), true)
  assert.equal(visibleNativeEvent({ type: 'message.part.delta', properties: { partID: 'text', delta: 'visible' } }, false, types), true)
  assert.equal(visibleNativeEvent({ type: 'message.part.delta', properties: { partID: 'reason', delta: 'visible by explicit setting' } }, true, types), true)
})

it('[F26] an empty advertised variant map does not authorize arbitrary named choices', () => {
  const provider = { all: [{ id: 'provider', models: { model: { variants: {} } } }] }
  assert.equal(providerSupports(provider, 'provider', 'model', 'invented'), false)
  assert.equal(providerSupports(provider, 'provider', 'model', ''), true)
  assert.equal(providerSupports(provider, 'provider', 'missing', ''), false)
})

it('[F28] parses CRLF, UTF-8, multiple data lines and SSE IDs at every byte split', async () => {
  const text = 'id: native-sse-1\r\ndata: {"type":"message.updated",\r\ndata: "properties":{"text":"café"}}\r\n\r\n'
  const bytes = new TextEncoder().encode(text)
  for (let split = 1; split < bytes.length; split += 1) {
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(bytes.slice(0, split)); controller.enqueue(bytes.slice(split)); controller.close()
    } })
    const events = []
    for await (const event of parseOpenCodeSse(stream)) events.push(event)
    assert.equal(events.length, 1, `split ${split}`)
    assert.equal(events[0]!.sseId, 'native-sse-1')
    assert.equal(object(events[0]!.properties).text, 'café')
  }
})

it('[F19,F28] early parser return cancels an actually open body and does not need EOF', async () => {
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('id: evt_1\ndata: {"type":"session.idle"}\n\n')) },
    cancel() { cancelled = true },
  })
  const iterator = parseOpenCodeSse(stream)[Symbol.asyncIterator]()
  assert.equal((await iterator.next()).done, false)
  await iterator.return?.()
  assert.equal(cancelled, true)
})

it('[F19] heartbeat expiry cancels a silent stream without imposing a healthy whole-stream lifetime', async () => {
  let cancelled = false
  const silent = new ReadableStream<Uint8Array>({ cancel() { cancelled = true } })
  const iterator = parseOpenCodeSse(silent, undefined, 10)[Symbol.asyncIterator]()
  await assert.rejects(iterator.next(), /heartbeat timed out/)
  assert.equal(cancelled, true)
})

for (const [label, source, expected] of [
  ['empty object', '{}', {}],
  ['comments and trailing commas', '{/* native */"items":[1,2,],"nested":{"allow":false,},}', { items: [1, 2], nested: { allow: false } }],
  ['quoted comment markers', '{"url":"https://host/path//text","note":"/* text */"}', { url: 'https://host/path//text', note: '/* text */' }],
  ['byte-order mark', '\uFEFF{"enabled":true}', { enabled: true }],
] as const) {
  it(`parses JSONC ${label}`, () => { assert.deepEqual(parseConfigObject(source), expected) })
}

for (const [label, source] of [
  ['unterminated comment', '{/* unterminated'],
  ['array root', '[]'],
  ['null root', 'null'],
  ['empty input', ''],
  ['missing value', '{"permission":}'],
  ['multiple documents', '{}{}'],
  ['JavaScript expression', '{"permission":process.env.SECRET}'],
] as const) {
  it(`rejects JSONC ${label}`, () => { assert.throws(() => parseConfigObject(source)) })
}

it('skips malformed SSE payloads and still forwards an unknown native event', async () => {
  const frames = ['not-json', 'null', '[]', '{"properties":{}}', '{"type":"future.event","properties":{"value":1}}']
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode(frames.map((frame) => `data: ${frame}\n\n`).join('')))
    controller.close()
  } })
  const events = []
  for await (const event of parseOpenCodeSse(stream)) events.push(event)
  assert.deepEqual(events, [{ type: 'future.event', properties: { value: 1 } }])
})
