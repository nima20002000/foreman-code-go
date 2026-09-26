// Managed stdio bridge to the owning app's authenticated, stateless MCP endpoint.
// Routes contain only a credential digest, never the credential itself.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const token = process.env.GRAPHQL_OPERATOR_MCP_TOKEN
const directory = join(dirname(fileURLToPath(import.meta.url)), 'routes')
const output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
let protocolVersion = '2025-03-26'
async function forward(message) {
  try {
    if (!token) throw new Error('missing credential')
    const key = createHash('sha256').update(token).digest('hex')
    const route = JSON.parse(await readFile(join(directory, `${key}.json`), 'utf8'))
    const url = new URL(route.endpoint)
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
      || url.pathname !== '/mcp/operator' || url.username || url.password || url.search || url.hash
      || !Number.isInteger(route.pid) || route.pid <= 0 || Date.parse(route.expiresAt) <= Date.now()
      || !Number.isFinite(Date.parse(route.expiresAt))) throw new Error('invalid route')
    process.kill(route.pid, 0)
    const response = await fetch(url, { method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': protocolVersion },
      body: JSON.stringify(message), signal: AbortSignal.timeout(120_000) })
    if (!response.ok) throw new Error('endpoint rejected request')
    if (response.status === 202 || response.status === 204) return
    const publish = (value) => {
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
    if (Object.hasOwn(message, 'id')) output({ jsonrpc: '2.0', id: message.id,
      error: { code: -32000, message: 'Operator MCP could not connect to its owning app. Reopen the Operator conversation to refresh its connection.' } })
  }
}
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
for await (const line of lines) {
  try {
    const message = JSON.parse(line)
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('invalid message')
    void forward(message)
  } catch { output({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON-RPC message.' } }) }
}
