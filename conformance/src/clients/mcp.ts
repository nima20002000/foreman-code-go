import { boundedBodyText, readSseFrames } from './streams.js'

export interface McpClientOptions { baseUrl: string; token: string; signal?: AbortSignal }
export interface McpToolDefinition extends Record<string, unknown> {
  name: string
  inputSchema: Record<string, unknown>
}
export interface McpToolResult extends Record<string, unknown> {
  content: Array<Record<string, unknown>>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('MCP returned a non-object protocol value.')
  return value as Record<string, unknown>
}

export class McpHttpError extends Error {
  constructor(readonly status: number, readonly body: unknown) {
    super(`MCP returned HTTP ${status}.`)
    this.name = 'McpHttpError'
  }
}

export class McpProtocolError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message)
    this.name = 'McpProtocolError'
  }
}

/** A real streamable-HTTP client; domain results are parsed by shared contracts in each scenario. */
export class McpClient {
  private readonly endpoint: URL
  private readonly token: string
  private readonly signal: AbortSignal | undefined
  private sequence = 0
  private protocolVersion = '2025-06-18'
  private sessionId: string | undefined
  private initialized: Promise<void> | undefined
  readonly notifications: Record<string, unknown>[] = []

  constructor(options: McpClientOptions) {
    const base = new URL(options.baseUrl)
    if (base.hostname !== '127.0.0.1' || base.protocol !== 'http:' || !base.port || base.pathname !== '/') {
      throw new Error('Conformance MCP must use its fresh loopback server origin.')
    }
    if (!options.token) throw new Error('A fresh Operator credential is required for MCP.')
    this.endpoint = new URL('/mcp', base)
    this.token = options.token
    this.signal = options.signal
  }

  async initialize(): Promise<void> {
    this.initialized ??= this.initializeProtocol()
    await this.initialized
  }

  private async initializeProtocol(): Promise<void> {
    const result = object(await this.request('initialize', {
      protocolVersion: this.protocolVersion, capabilities: {},
      clientInfo: { name: 'foreman-conformance', version: '0.1.0' },
    }))
    if (typeof result.protocolVersion !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(result.protocolVersion)) {
      throw new Error('MCP initialization did not negotiate a protocol version.')
    }
    object(result.capabilities)
    const serverInfo = object(result.serverInfo)
    if (typeof serverInfo.name !== 'string' || typeof serverInfo.version !== 'string') {
      throw new Error('MCP initialization returned invalid server metadata.')
    }
    this.protocolVersion = result.protocolVersion
    await this.notify('notifications/initialized')
  }

  async listTools(): Promise<McpToolDefinition[]> {
    await this.initialize()
    const tools: McpToolDefinition[] = []
    const names = new Set<string>()
    const cursors = new Set<string>()
    let cursor: string | undefined
    do {
      const page = object(await this.request('tools/list', cursor ? { cursor } : {}))
      if (!Array.isArray(page.tools)) throw new Error('MCP tools/list returned no tool array.')
      for (const value of page.tools) {
        const tool = object(value)
        if (typeof tool.name !== 'string' || !tool.name || names.has(tool.name)) {
          throw new Error('MCP tools/list returned an invalid or duplicate tool name.')
        }
        object(tool.inputSchema)
        names.add(tool.name)
        tools.push(tool as McpToolDefinition)
      }
      if (tools.length > 10_000) throw new Error('MCP tool catalog exceeds the conformance bound.')
      cursor = undefined
      if (page.nextCursor !== undefined) {
        if (typeof page.nextCursor !== 'string' || !page.nextCursor || cursors.has(page.nextCursor) || !page.tools.length) {
          throw new Error('MCP tools/list returned a non-progressing cursor.')
        }
        cursor = page.nextCursor
        cursors.add(cursor)
      }
    } while (cursor)
    return tools
  }

  async callTool(name: string, argumentsValue: Record<string, unknown>, options: { token?: string } = {}): Promise<McpToolResult> {
    await this.initialize()
    const result = object(await this.request('tools/call', { name, arguments: argumentsValue }, options.token))
    if (!Array.isArray(result.content) || result.content.some(value => typeof object(value).type !== 'string')) {
      throw new Error('MCP tool result has invalid content blocks.')
    }
    if (result.isError !== undefined && typeof result.isError !== 'boolean') throw new Error('MCP isError is not a boolean.')
    if (result.structuredContent !== undefined) object(result.structuredContent)
    return result as McpToolResult
  }

  private async post(body: unknown, token = this.token): Promise<Response> {
    const headers = new Headers({ 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`, 'mcp-protocol-version': this.protocolVersion })
    if (this.sessionId) headers.set('mcp-session-id', this.sessionId)
    const init: RequestInit = { method: 'POST', body: JSON.stringify(body), headers, redirect: 'manual' }
    if (this.signal) init.signal = this.signal
    const response = await fetch(this.endpoint, init)
    if (!response.ok) {
      const text = await boundedBodyText(response)
      const value: unknown = response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text
      throw new McpHttpError(response.status, value)
    }
    const session = response.headers.get('mcp-session-id')
    if (session) {
      if (this.sessionId && this.sessionId !== session) {
        await response.body?.cancel()
        throw new Error('MCP changed the initialized session identity.')
      }
      this.sessionId = session
    }
    const protocol = response.headers.get('mcp-protocol-version')
    if (protocol) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(protocol)) {
        await response.body?.cancel()
        throw new Error('MCP returned an invalid protocol version header.')
      }
      this.protocolVersion = protocol
    }
    return response
  }

  private async notify(method: string): Promise<void> {
    const response = await this.post({ jsonrpc: '2.0', method })
    const text = await boundedBodyText(response)
    if (response.status !== 202 || text) throw new Error('MCP notification was not acknowledged with an empty HTTP 202.')
  }

  private responseValue(value: unknown, id: number): { matched: false } | { matched: true; result: unknown } {
    const message = object(value)
    if (message.jsonrpc !== '2.0') throw new Error('MCP response has an invalid JSON-RPC version.')
    if (message.method !== undefined) {
      if (message.id !== undefined) throw new Error('MCP requested an unsupported client callback.')
      if (typeof message.method !== 'string' || this.notifications.length >= 256) throw new Error('MCP notification is invalid or unbounded.')
      this.notifications.push(message)
      return { matched: false }
    }
    if (message.id !== id) throw new Error('MCP response does not match its request ID.')
    if (message.error !== undefined) {
      const error = object(message.error)
      if (typeof error.code !== 'number' || !Number.isInteger(error.code) || typeof error.message !== 'string') {
        throw new Error('MCP returned an invalid JSON-RPC error.')
      }
      throw new McpProtocolError(error.code, error.message, error.data)
    }
    if (!Object.hasOwn(message, 'result')) throw new Error('MCP response has neither a result nor an error.')
    return { matched: true, result: message.result }
  }

  private async request(method: string, params: Record<string, unknown>, token?: string): Promise<unknown> {
    const id = ++this.sequence
    const response = await this.post({ jsonrpc: '2.0', id, method, params }, token)
    const contentType = response.headers.get('content-type') ?? ''
    if (contentType.startsWith('application/json')) {
      const value = this.responseValue(JSON.parse(await boundedBodyText(response)), id)
      if (value.matched) return value.result
    } else if (contentType.startsWith('text/event-stream') && response.body) {
      for await (const frame of readSseFrames(response.body)) {
        if (frame.data === undefined) continue
        if (frame.event !== 'message') throw new Error(`Unexpected MCP SSE event: ${frame.event}`)
        const value = this.responseValue(JSON.parse(frame.data), id)
        if (value.matched) return value.result
      }
    } else {
      await response.body?.cancel()
      throw new Error('MCP returned an unsupported response media type.')
    }
    throw new Error('MCP closed without the requested JSON-RPC response.')
  }
}

export async function listOperatorToolNames(options: McpClientOptions): Promise<string[]> {
  return (await new McpClient(options).listTools()).map(tool => tool.name)
}
