import assert from 'node:assert/strict'
import { it } from 'vitest'
import { OpenCodeNativeSessionManager } from '../src/modules/harnesses/opencodeServer.js'
import { createOpenCodeSdkTransport } from '../src/modules/harnesses/opencodeSdkClient.js'
import { OPENCODE_HTTP_BODY_LIMIT } from '../src/modules/harnesses/opencodeClient.js'
import { nativeMessageId, object } from '../src/modules/harnesses/opencodeProtocol.js'
import { FixtureServer, request } from './opencode-fixtures.js'

for (const transport of ['raw', 'sdk'] as const) {
  it(`recovers a multi-image native prompt and allows its successor through the ${transport} transport`, async () => {
    const server = new FixtureServer()
    server.config = { mcp: { graphql: { enabled: false } } }
    const native = new OpenCodeNativeSessionManager({ server, ownerAgentId: 'agent-1', appMcpAccess: 'none',
      ...(transport === 'sdk' ? { clientFactory: createOpenCodeSdkTransport } : {}),
    })
    try {
      const session = await native.createSession({ request: request() })
      const root = server.user('media', 'compare the photos', session.nativeSessionId)
      const url = 'data:image/png;base64,' + 'A'.repeat(5 * 1024 * 1024)
      root.parts.push(...[0, 1].map(index => ({ id: `image-${index}`, sessionID: session.nativeSessionId,
        messageID: root.info.id, type: 'file', mime: 'image/png', filename: `photo-${index}.png`, url })))
      const answer = server.assistant(String(root.info.id), 'Recovered comparison', 'stop', true, session.nativeSessionId)
      assert(Buffer.byteLength(JSON.stringify(root)) > OPENCODE_HTTP_BODY_LIMIT)
      const recovered = await native.reconcile(session, 'media')
      assert.deepEqual(recovered.terminalResult, { outcome: 'succeeded', output: { text: 'Recovered comparison' } })
      assert.equal(recovered.nativeMessageId, answer.info.id)
      const files = recovered.events.filter(event => object(event.payload.part).type === 'file')
      assert.equal(files.length, 2)
      assert(files.every(event => /^urn:opencode:media:sha256:[a-f0-9]{64}$/.test(String(object(event.payload.part).url))))
      assert(Buffer.byteLength(JSON.stringify(recovered)) < 20_000)
      assert.equal(root.parts.at(-1)!.url, url)
      server.onPrompt = () => { server.complete('successor', 'Completed successor', session.nativeSessionId) }
      for await (const event of native.startTurn(session, { prompt: 'continue', clientCorrelationId: 'successor' })) void event
      assert.equal((await native.reconcile(session, 'successor')).terminalResult?.outcome, 'succeeded')
      assert.equal(server.calls.filter(call => call.path.includes('/prompt_async')).length, 1)
      assert.equal(server.calls.filter(call => call.path.includes('/abort')).length, 0)
    } finally { await native.dispose() }
  })

  it(`pages oversized non-media history without losing cursors or selecting another turn through ${transport}`, async () => {
    const server = new FixtureServer()
    const native = new OpenCodeNativeSessionManager({ server, ownerAgentId: 'agent-1',
      ...(transport === 'sdk' ? { clientFactory: createOpenCodeSdkTransport } : {}),
    })
    try {
      const session = await native.createSession({ request: request() })
      const root = server.user('older')
      const answer = server.assistant(String(root.info.id), 'Selected older answer')
      for (let index = 0; index < 64; index += 1) server.user(`later-${index}`, 'x'.repeat(160_000))
      const recovered = await native.reconcile(session, 'older')
      assert.equal(object(recovered.terminalResult?.output).text, 'Selected older answer')
      assert.equal(recovered.nativeMessageId, answer.info.id)
      const reads = server.calls.filter(call => call.path.includes('/message?')).map(call => new URL(call.path, 'http://native.invalid'))
      assert(reads.some(url => url.searchParams.get('limit') === '64'))
      assert(reads.some(url => url.searchParams.get('limit') === '32'))
      assert(reads.some(url => url.searchParams.has('before')))
      const ids = new Set<string>()
      let before: string | undefined
      do {
        const page = await native.historyPage(session, before)
        for (const event of page.events) {
          if (event.type === 'message.updated') {
            const id = String(object(event.payload.info).id)
            assert.equal(ids.has(id), false)
            ids.add(id)
          }
        }
        before = page.nextCursor
      } while (before)
      assert.equal(ids.size, 66)
      assert(ids.has(nativeMessageId('older')))
      assert.equal(server.calls.filter(call => call.path.includes('/prompt_async')).length, 0)
    } finally { await native.dispose() }
  })
}
