import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { openBrowserStream, type BrowserStream } from './streams.js'

const wireFrame = 'id: 7\nevent: state\ndata: {"turnState":"idle"}\n\n'
const expectedFrame = {
  event: 'state', data: '{"turnState":"idle"}', id: '7', retry: undefined,
  comments: [], raw: wireFrame,
}

async function withBrowserStream(
  run: (stream: BrowserStream, disconnected: Promise<void>) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let notifyDisconnected!: () => void
  const disconnected = new Promise<void>(resolve => { notifyDisconnected = resolve })
  const server = createServer((_request, response) => {
    response.once('close', notifyDisconnected)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(wireFrame)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  let stream: BrowserStream | undefined
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('The test SSE listener has no TCP address.')
    stream = await openBrowserStream({ baseUrl: `http://127.0.0.1:${address.port}`,
      path: '/events', headers: {}, ...(signal ? { signal } : {}) })
    await run(stream, disconnected)
  } finally {
    try { await stream?.close() }
    finally {
      await new Promise<void>((resolve, reject) => {
        server.close(error => { if (error) reject(error); else resolve() })
        server.closeAllConnections()
      })
    }
  }
}

describe('browser stream intentional close', () => {
  it('closes an observed live HTTP stream without turning its owned cancellation into a failure', async () => {
    await withBrowserStream(async (stream, disconnected) => {
      expect(await stream.frames.next()).toEqual({ done: false, value: expectedFrame })
      await expect(stream.close()).resolves.toBeUndefined()
      await disconnected
      expect(await stream.frames.next()).toEqual({ done: true, value: undefined })
      await expect(stream.close()).resolves.toBeUndefined()
    })
  })

  it('preserves an external cancellation even when it has the same text as an intentional close', async () => {
    const external = new AbortController()
    const reason = new Error('Browser stream closed by its scenario.')
    await withBrowserStream(async (stream, disconnected) => {
      expect(await stream.frames.next()).toEqual({ done: false, value: expectedFrame })
      external.abort(reason)
      await expect(stream.close()).rejects.toBe(reason)
      await disconnected
    }, external.signal)
  })
})
