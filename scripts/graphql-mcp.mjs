// Managed stdio bridge to the owning app's authenticated, stateless MCP endpoint.
// Routes contain only a credential digest, never the credential itself.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const token = process.env.FOREMAN_CODE_MCP_TOKEN ?? process.env.GRAPHQL_MCP_TOKEN
const tokenConflict = process.env.FOREMAN_CODE_MCP_TOKEN !== undefined && process.env.GRAPHQL_MCP_TOKEN !== undefined
  && process.env.FOREMAN_CODE_MCP_TOKEN !== process.env.GRAPHQL_MCP_TOKEN
const directory = join(dirname(fileURLToPath(import.meta.url)), 'routes')
const output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
let protocolVersion = '2025-03-26'
const pending = new Map()

class BridgeFailure extends Error {
  constructor(kind, message, status) {
    super(message)
    this.kind = kind
    this.status = status
  }
}

function httpFailure(status) {
  if (status === 401) return new BridgeFailure('authentication',
    'MCP authentication expired or was revoked. Refresh the owning app credential before retrying.', status)
  if (status === 403) return new BridgeFailure('forbidden',
    'MCP access was denied. Ask the owning app operator to check this credential’s grants and scope.', status)
  if (status === 413) return new BridgeFailure('request_too_large',
    'The MCP request is too large. Reduce the request payload before retrying.', status)
  if (status === 429 || status >= 500) return new BridgeFailure('service_unavailable',
    'The owning app MCP service is temporarily unavailable. Retry later; read back any decision before retrying a write.', status)
  return new BridgeFailure('http_error',
    `The owning app rejected the MCP request (HTTP ${status}). Check the request before retrying.`, status)
}

function bridgeError(error, deliveryStage) {
  if (error instanceof BridgeFailure) return {
    code: -32000, message: error.message,
    data: { kind: error.kind, ...(error.status ? { httpStatus: error.status } : {}) },
  }
  if (error?.name === 'TimeoutError') return { code: -32000,
    message: 'The MCP request timed out. Read back any decision before retrying; the owning app may have committed it.',
    data: { kind: 'timeout', delivery: 'indeterminate' } }
  if (error instanceof SyntaxError) return { code: -32000,
    message: 'The owning app returned an invalid MCP response. Read back the original command before retrying a write; it may have been committed.',
    data: { kind: 'invalid_response', delivery: 'indeterminate' } }
  const unsent = deliveryStage === 'dispatched'
    && ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(error?.cause?.code)
  if (deliveryStage !== 'preflight' && !unsent) return { code: -32000,
    message: 'The MCP response was interrupted or incomplete. Read back the original command before retrying a write; it may have been committed.',
    data: { kind: 'indeterminate_delivery', delivery: 'indeterminate' } }
  return { code: -32000,
    message: 'MCP could not connect to its owning app. Check that the owning app is running and retry.',
    data: { kind: 'transport' } }
}

async function forward(message, controller) {
  let requestSignal
  let deliveryStage = 'preflight'
  let terminalReceived = false
  const expectsReply = Object.hasOwn(message, 'id')
  try {
    if (tokenConflict) throw new BridgeFailure('configuration',
      'FOREMAN_CODE_MCP_TOKEN conflicts with GRAPHQL_MCP_TOKEN. Supply one credential or matching credentials.')
    if (!token) throw new BridgeFailure('authentication', 'The MCP credential is missing. Refresh the owning app credential.')
    const key = createHash('sha256').update(token).digest('hex')
    let route
    try {
      route = JSON.parse(await readFile(join(directory, `${key}.json`), 'utf8'))
    } catch {
      throw new BridgeFailure('route_unavailable',
        'The owning app MCP route is unavailable. Open the owning app to refresh this credential’s connection.')
    }
    const url = new URL(route.endpoint)
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
      || url.pathname !== '/mcp' || url.username || url.password || url.search || url.hash
      || !Number.isInteger(route.pid) || route.pid <= 0 || Date.parse(route.expiresAt) <= Date.now()
      || !Number.isFinite(Date.parse(route.expiresAt))) throw new BridgeFailure('route_unavailable',
        'The owning app MCP route is invalid or expired. Open the owning app to refresh this credential’s connection.')
    // The owning API's host PID is not visible inside a harness PID namespace.
    // Each request proves access through the endpoint's scoped credential authentication.
    requestSignal = controller ? AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)])
      : AbortSignal.timeout(120_000)
    deliveryStage = 'dispatched'
    const response = await fetch(url, { method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': protocolVersion },
      body: JSON.stringify(message), signal: requestSignal })
    deliveryStage = 'response'
    if (!response.ok) {
      try {
        await response.body?.cancel()
      } finally {
        throw httpFailure(response.status)
      }
    }
    if ((response.status === 202 || response.status === 204) && !expectsReply) return
    const publish = (value) => {
      if (controller?.signal.aborted || terminalReceived) return
      const terminal = expectsReply && value?.id === message.id
        && (Object.hasOwn(value, 'result') || Object.hasOwn(value, 'error'))
      if (message.method === 'initialize' && value.result?.protocolVersion) protocolVersion = value.result.protocolVersion
      output(value)
      if (terminal) terminalReceived = true
    }
    if (response.headers.get('content-type')?.includes('application/json')) publish(await response.json())
    else {
      let buffer = ''
      const decoder = new TextDecoder()
      for await (const chunk of response.body) {
        buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, '\n')
        let boundary
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const event = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const data = event.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
          if (data) publish(JSON.parse(data))
          if (terminalReceived) return
        }
      }
    }
    if (expectsReply && !terminalReceived) throw new Error('Missing terminal MCP response.')
  } catch (error) {
    if (controller?.signal.aborted || terminalReceived) return
    if (expectsReply) output({ jsonrpc: '2.0', id: message.id,
      error: bridgeError(requestSignal?.aborted ? requestSignal.reason : error, deliveryStage) })
  } finally {
    if (controller && pending.get(message.id) === controller) pending.delete(message.id)
  }
}
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
for await (const line of lines) {
  try {
    const message = JSON.parse(line)
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('invalid message')
    if (message.method === 'notifications/cancelled') pending.get(message.params?.requestId)?.abort()
    if (Object.hasOwn(message, 'id')) {
      if (pending.has(message.id)) {
        output({ jsonrpc: '2.0', id: message.id, error: { code: -32600, message: 'This MCP request id is already in flight.' } })
        continue
      }
      const controller = new AbortController()
      pending.set(message.id, controller)
      void forward(message, controller)
    } else void forward(message)
  } catch { output({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON-RPC message.' } }) }
}
for (const controller of pending.values()) controller.abort()
