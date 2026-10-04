// Managed stdio bridge to the owning app's authenticated, stateless MCP endpoint.
// Routes contain only a credential digest, never the credential itself.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const token = process.env.GRAPHQL_MCP_TOKEN
const directory = join(dirname(fileURLToPath(import.meta.url)), 'routes')
const output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
let protocolVersion = '2025-03-26'
const pending = new Map()
async function forward(message, controller) {
  try {
    if (!token) throw new Error('missing credential')
    const key = createHash('sha256').update(token).digest('hex')
    const route = JSON.parse(await readFile(join(directory, `${key}.json`), 'utf8'))
    const url = new URL(route.endpoint)
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
      || url.pathname !== '/mcp' || url.username || url.password || url.search || url.hash
      || !Number.isInteger(route.pid) || route.pid <= 0 || Date.parse(route.expiresAt) <= Date.now()
      || !Number.isFinite(Date.parse(route.expiresAt))) throw new Error('invalid route')
    process.kill(route.pid, 0)
    const response = await fetch(url, { method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': protocolVersion },
      body: JSON.stringify(message), signal: controller
        ? AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000) })
    if (!response.ok) throw new Error('endpoint rejected request')
    if (response.status === 202 || response.status === 204) return
    const publish = (value) => {
      if (controller?.signal.aborted) return
      if (message.method === 'initialize' && value.result?.protocolVersion) protocolVersion = value.result.protocolVersion
      output(value)
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
        }
      }
    }
  } catch {
    if (controller?.signal.aborted) return
    if (Object.hasOwn(message, 'id')) output({ jsonrpc: '2.0', id: message.id,
      error: { code: -32000, message: 'GraphQL MCP could not connect to its owning app. Restart the conversation or execution to refresh its connection.' } })
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
