import { afterEach, describe, expect, it, vi } from 'vitest'
import { PublicHttpClient } from './http.js'
import { boundedBodyBytes } from './streams.js'

const origin = 'http://127.0.0.1:49151'

describe('public binary HTTP transfers', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('uploads exact bytes and retains the complete HTTP response', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = []
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init })
      return Response.json({ value: { fileId: 'owned-file' }, replayed: false }, { status: 201 })
    })
    const http = new PublicHttpClient({ baseUrl: origin, browserOrigin: origin })
    const bytes = Uint8Array.of(0, 255, 1, 127)
    const response = await http.upload('/api/files/uploads/owned-request', bytes)
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.url).toBe(`${origin}/api/files/uploads/owned-request`)
    expect(call.init?.method).toBe('PUT')
    expect(call.init?.redirect).toBe('manual')
    expect(new Headers(call.init?.headers).get('content-type')).toBe('application/octet-stream')
    expect(call.init?.body).toEqual(bytes.buffer)
    expect(response.status).toBe(201)
    expect(response.body).toEqual({ value: { fileId: 'owned-file' }, replayed: false })
  })

  it('downloads binary content without UTF-8 decoding or dropping response status and headers', async () => {
    const bytes = Uint8Array.of(0, 255, 128, 1)
    vi.stubGlobal('fetch', async () => new Response(bytes, { status: 200,
      headers: { 'content-type': 'image/png', 'content-length': String(bytes.byteLength) } }))
    const http = new PublicHttpClient({ baseUrl: origin, browserOrigin: origin })
    const response = await http.download('/api/files/owned-file/content')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.body).toEqual(Buffer.from(bytes))
    await expect(http.download('https://example.invalid/file')).rejects.toThrow('owned server')
  })

  it('cancels an oversized response instead of retaining an unbounded body', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(Uint8Array.of(1, 2, 3, 4)) },
      cancel,
    })
    await expect(boundedBodyBytes(new Response(body), 3)).rejects.toThrow('byte bound')
    expect(cancel).toHaveBeenCalledOnce()
  })
})
