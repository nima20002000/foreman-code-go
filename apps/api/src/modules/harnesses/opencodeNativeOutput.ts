import { awaitNativeOutputContext } from '../runs/remote/nativeOutputAdmission.js'
import { DomainError } from '../errors.js'
import { createServer } from 'node:http'
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/server'
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import { WORKER_NATIVE_OUTPUT_TOOL_NAMES, WorkerNativeOutputCommandSchema } from '@graphql/contracts/worker-native-output'
import { toolFailure, toolResult } from '../../mcp/shared/results.js'
import type { NativeOutputBridge, NativeOutputTurnPin } from './workflowNativeOutput.js'
import type { OpenCodeServerController } from './opencodeTransport.js'

/** One authenticated MCP listener for one original turn. The secret stays in the
 * provider's MCP headers; neither tool arguments nor outputs contain host paths. */
export async function openOpenCodeNativeOutputTurn(input: {
  bridge: NativeOutputBridge
  server: OpenCodeServerController
  directory: string
  pin: NativeOutputTurnPin
  signal: AbortSignal
  rememberCredential?(token: string): void
}) {
  const token = randomBytes(32).toString('base64url')
  input.rememberCredential?.(token)
  const secret = createHash('sha256').update(`Bearer ${token}`).digest()
  const name = `graphql_outputs_${createHash('sha256').update(JSON.stringify([
    input.pin.session.nativeSessionId, input.pin.nativeTurnId,
  ])).digest('hex').slice(0, 24)}`
  let closed = false
  let activated = false
  const active = new Set<Promise<unknown>>()
  const listener = createServer((request, response) => {
    const task = (async () => {
      response.setHeader('cache-control', 'no-store')
      const supplied = createHash('sha256').update(request.headers.authorization ?? '').digest()
      if (closed || !timingSafeEqual(secret, supplied)) { response.writeHead(401); response.end(); return }
      if (request.method !== 'POST' || request.url !== '/mcp') { response.writeHead(405); response.end(); return }
      const parts: Buffer[] = []
      let length = 0
      for await (const part of request) {
        const bytes = Buffer.from(part)
        length += bytes.length
        if (length > 128 * 1024) { response.writeHead(413); response.end(); return }
        parts.push(bytes)
      }
      const body = JSON.parse(Buffer.concat(parts).toString('utf8')) as { id?: string | number }
      const server = new McpServer({ name: 'graphql-native-outputs', version: '1.0.0' })
      for (const schema of WorkerNativeOutputCommandSchema.options) {
        const operation = schema.shape.operation.value
        server.registerTool(WORKER_NATIVE_OUTPUT_TOOL_NAMES[operation], { inputSchema: schema,
          description: `${operation} the original turn's output. Outputs contain no filesystem paths.`,
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        }, async raw => {
          try {
            await awaitNativeOutputContext(async bounded => {
              bounded.throwIfAborted()
              if (closed) throw new Error('Native output turn closed.')
              if (!activated) throw new DomainError('NATIVE_ARTIFACT_CONTEXT_PENDING', 'Native turn admission is pending.', 409)
            }, input.signal)
            input.pin.assertCurrent()
            return toolResult(await input.bridge.dispatch(WorkerNativeOutputCommandSchema.parse(raw), {
              ...input.pin, callId: String(body.id ?? ''), assertCurrent: () => {
                input.pin.assertCurrent()
                if (!activated || closed) throw new Error('Native output turn closed.')
              },
            }, input.signal))
          } catch (error) { return toolFailure(error) }
        })
      }
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      response.once('close', () => { void Promise.allSettled([transport.close(), server.close()]) })
      await server.connect(transport)
      await transport.handleRequest(request, response, body)
    })().catch(() => { if (!response.headersSent) response.writeHead(502); response.end() })
    active.add(task)
    void task.then(() => active.delete(task))
  })
  listener.requestTimeout = 30_000
  listener.headersTimeout = 10_000
  listener.keepAliveTimeout = 1000
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', () => { listener.removeListener('error', reject); resolve() })
  })
  const address = listener.address()
  if (!address || typeof address === 'string') throw new Error('Native output listener unavailable.')
  const native = async (path: string, body: unknown) => {
    const response = await input.server.request(`${path}?directory=${encodeURIComponent(input.directory)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }, input.signal, input.pin.runtimeGeneration)
    if (!response.ok) throw new Error('OpenCode output MCP registration failed.')
    await response.body?.cancel()
  }
  const close = async (options: { processClosed?: true } = {}) => {
    closed = true
    activated = false
    await input.bridge.close()
    if (!options.processClosed) await native(`/mcp/${encodeURIComponent(name)}/disconnect`, {})
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()))
    await Promise.all(active)
  }
  try {
    await native('/mcp', { name, config: { type: 'remote',
      url: `http://127.0.0.1:${address.port}/mcp`, enabled: true, oauth: false,
      headers: { Authorization: `Bearer ${token}` } } })
  } catch (error) { await close({ processClosed: true }); throw error }
  return { activate: async () => {
    await input.bridge.activate(input.pin, input.signal)
    input.pin.assertCurrent()
    if (closed) throw new Error('Native output turn closed before admission.')
    activated = true
  }, close }
}
