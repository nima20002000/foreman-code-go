import assert from 'node:assert/strict'
import { it } from 'vitest'

import { buildOpenCodeConfigContent } from '../src/modules/harnesses/opencodeServer.js'
import { credentialReferences, parseConfigObject, parseOpenCodeSse, providerSupports, visibleNativeEvent, object } from '../src/modules/harnesses/opencodeProtocol.js'
import { advanced } from './opencode-fixtures.js'

it('[F25] merges valid JSONC comments and trailing commas without corrupting quoted text', () => {
  const source = `{
    // Native inline config accepts JSONC.
    "model": "provider/model", "url": "https://host/path//not-a-comment",
    "note": "escaped quote: \\\u0022 /* still string */",
    "plugin": ["one",], /* block comment */
    "compaction": { "custom": true, },
  }`
  const selected = { ...advanced(), subagentDepth: 0, compaction: { auto: false, prune: true, tailTurns: 4, preserveRecentTokens: 2_048 } }
  const result = JSON.parse(buildOpenCodeConfigContent(source, selected))
  assert.equal(result.url, 'https://host/path//not-a-comment')
  assert.deepEqual(result.plugin, ['one'])
  assert.deepEqual(result.compaction, { custom: true, auto: false, prune: true, tail_turns: 4, preserve_recent_tokens: 2_048 })
  assert.equal(result.subagent_depth, 0)
  assert.throws(() => parseConfigObject('{/* unterminated'))
  assert.throws(() => parseConfigObject('[]'))
})

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
