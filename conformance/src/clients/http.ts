import { boundedBodyBytes, boundedBodyText } from './streams.js'

export interface PublicResponse {
  status: number
  headers: Headers
  body: unknown
}

export interface PublicBinaryResponse {
  status: number
  headers: Headers
  body: Buffer
}

export interface HeaderOptions {
  token?: string | null
  headers?: HeadersInit
}

export interface TransportOptions extends HeaderOptions {
  signal?: AbortSignal
}

export interface RequestOptions extends TransportOptions { body?: unknown }

async function jsonResponse(response: Response): Promise<PublicResponse> {
  const text = await boundedBodyText(response)
  let body: unknown = text
  if (text.length === 0) body = null
  else if (response.headers.get('content-type')?.includes('json')) body = JSON.parse(text)
  return { status: response.status, headers: response.headers, body }
}

export class PublicHttpClient {
  readonly baseUrl: string
  private readonly browserOrigin: string
  private readonly token: string | undefined
  private readonly signal: AbortSignal | undefined

  constructor(options: { baseUrl: string; browserOrigin: string; token?: string; signal?: AbortSignal }) {
    const url = new URL(options.baseUrl)
    if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:' || !url.port || url.pathname !== '/') {
      throw new Error('Conformance HTTP must use its fresh loopback server origin')
    }
    this.baseUrl = url.origin
    this.browserOrigin = options.browserOrigin
    this.token = options.token
    this.signal = options.signal
  }

  requestHeaders(options: HeaderOptions = {}): Headers {
    const headers = new Headers({ accept: 'application/json', origin: this.browserOrigin })
    for (const [key, value] of new Headers(options.headers)) headers.set(key, value)
    const token = options.token === undefined ? this.token : options.token
    if (token) headers.set('authorization', `Bearer ${token}`)
    if (options.token === null) headers.delete('authorization')
    return headers
  }

  private async send(method: string, path: string, options: TransportOptions, body?: BodyInit): Promise<Response> {
    const url = new URL(path, this.baseUrl)
    if (!path.startsWith('/') || path.startsWith('//') || url.origin !== this.baseUrl) {
      throw new Error('Conformance requests must remain on their owned server')
    }
    const headers = this.requestHeaders(options)
    const signals = [this.signal, options.signal].filter((signal): signal is AbortSignal => signal !== undefined)
    const init: RequestInit = { method, headers, redirect: 'manual' }
    if (signals.length) init.signal = AbortSignal.any(signals)
    if (body !== undefined) init.body = body
    return fetch(url, init)
  }

  async request(method: string, path: string, options: RequestOptions = {}): Promise<PublicResponse> {
    const headers = new Headers(options.headers)
    let body: string | undefined
    if (options.body !== undefined) {
      headers.set('content-type', 'application/json')
      body = JSON.stringify(options.body)
    }
    return jsonResponse(await this.send(method, path, { ...options, headers }, body))
  }

  async upload(path: string, bytes: Uint8Array, options: TransportOptions = {}): Promise<PublicResponse> {
    const headers = new Headers(options.headers)
    if (!headers.has('content-type')) headers.set('content-type', 'application/octet-stream')
    return jsonResponse(await this.send('PUT', path, { ...options, headers }, Uint8Array.from(bytes).buffer))
  }

  async download(path: string, options: TransportOptions = {}): Promise<PublicBinaryResponse> {
    const response = await this.send('GET', path, options)
    return { status: response.status, headers: response.headers, body: await boundedBodyBytes(response) }
  }
}
