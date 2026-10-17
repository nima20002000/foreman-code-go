export interface SseFrame {
  event: string
  data: string | undefined
  id: string | undefined
  retry: number | undefined
  comments: string[]
  raw: string
}

const MAX_FRAME_BYTES = 1024 * 1024

/** Incremental EventSource framing, retaining comments and wire text for assertions. */
class SseDecoder {
  private text = ''
  private lines: string[] = []
  private raw = ''
  private first = true

  push(text: string, final = false): SseFrame[] {
    if (this.first && text) {
      this.first = false
      text = text.replace(/^\uFEFF/, '')
    }
    this.text += text
    const frames: SseFrame[] = []
    while (this.text.length) {
      const end = this.text.search(/[\r\n]/)
      if (end < 0) break
      if (this.text[end] === '\r' && end === this.text.length - 1 && !final) break
      const terminator = this.text[end] === '\r' && this.text[end + 1] === '\n' ? 2 : 1
      const line = this.text.slice(0, end)
      this.raw += this.text.slice(0, end + terminator)
      this.text = this.text.slice(end + terminator)
      if (Buffer.byteLength(this.raw) > MAX_FRAME_BYTES) throw new Error('SSE frame exceeds the conformance byte bound.')
      if (line) this.lines.push(line)
      else if (this.lines.length) {
        frames.push(this.frame())
        this.lines = []
        this.raw = ''
      } else this.raw = ''
      this.assertBound()
    }
    this.assertBound()
    if (final && (this.text || this.lines.length)) throw new Error('SSE ended in an incomplete frame.')
    return frames
  }

  private assertBound(): void {
    if (Buffer.byteLength(this.raw) + Buffer.byteLength(this.text) > MAX_FRAME_BYTES) {
      throw new Error('SSE frame exceeds the conformance byte bound.')
    }
  }

  private frame(): SseFrame {
    const data: string[] = []
    const frame: SseFrame = { event: 'message', data: undefined, id: undefined,
      retry: undefined, comments: [], raw: this.raw }
    for (const line of this.lines) {
      if (line.startsWith(':')) { frame.comments.push(line.slice(1).replace(/^ /, '')); continue }
      const colon = line.indexOf(':')
      const field = colon < 0 ? line : line.slice(0, colon)
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
      if (field === 'data') data.push(value)
      if (field === 'event' && value) frame.event = value
      if (field === 'id' && !value.includes('\0')) frame.id = value
      if (field === 'retry' && /^\d+$/.test(value)) frame.retry = Number(value)
    }
    if (data.length) frame.data = data.join('\n')
    return frame
  }
}

export async function* readSseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = body.getReader()
  const utf8 = new TextDecoder('utf-8', { fatal: true })
  const decoder = new SseDecoder()
  let ended = false
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) {
        ended = true
        for (const frame of decoder.push(utf8.decode(), true)) yield frame
        return
      }
      for (const frame of decoder.push(utf8.decode(chunk.value, { stream: true }))) yield frame
    }
  } finally {
    try { if (!ended) await reader.cancel() }
    finally { reader.releaseLock() }
  }
}

export async function boundedBodyBytes(response: Response, maximumBytes = 8 * 1024 * 1024): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  let ended = false
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) { ended = true; break }
      bytes += chunk.value.byteLength
      if (bytes > maximumBytes) throw new Error('HTTP response exceeds the conformance byte bound.')
      chunks.push(chunk.value)
    }
    return Buffer.concat(chunks)
  } finally {
    try { if (!ended) await reader.cancel() }
    finally { reader.releaseLock() }
  }
}

export async function boundedBodyText(response: Response, maximumBytes = 8 * 1024 * 1024): Promise<string> {
  return new TextDecoder('utf-8', { fatal: true }).decode(await boundedBodyBytes(response, maximumBytes))
}

export class StreamHttpError extends Error {
  constructor(readonly status: number, readonly body: unknown) {
    super(`Browser stream returned HTTP ${status}.`)
    this.name = 'StreamHttpError'
  }
}

export interface BrowserStream {
  status: number
  headers: Headers
  frames: AsyncGenerator<SseFrame>
  close(): Promise<void>
}

export async function openBrowserStream(options: {
  baseUrl: string
  path: string
  headers: HeadersInit
  signal?: AbortSignal
  lastEventId?: string
}): Promise<BrowserStream> {
  const base = new URL(options.baseUrl)
  const url = new URL(options.path, base)
  if (base.hostname !== '127.0.0.1' || base.protocol !== 'http:' || !base.port
    || !options.path.startsWith('/') || url.origin !== base.origin) {
    throw new Error('Browser streams must use their fresh loopback server.')
  }
  const lifetime = new AbortController()
  const signal = options.signal ? AbortSignal.any([lifetime.signal, options.signal]) : lifetime.signal
  const headers = new Headers(options.headers)
  headers.set('accept', 'text/event-stream')
  if (options.lastEventId !== undefined) headers.set('last-event-id', options.lastEventId)
  const response = await fetch(url, { headers, signal, redirect: 'manual' })
  if (!response.ok) {
    const text = await boundedBodyText(response)
    const body: unknown = response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text
    throw new StreamHttpError(response.status, body)
  }
  if (!response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body) {
    await response.body?.cancel()
    throw new Error('Browser stream did not return an SSE body.')
  }
  const frames = readSseFrames(response.body)
  return { status: response.status, headers: response.headers, frames,
    async close() {
      lifetime.abort(new Error('Browser stream closed by its scenario.'))
      await frames.return(undefined)
    },
  }
}
