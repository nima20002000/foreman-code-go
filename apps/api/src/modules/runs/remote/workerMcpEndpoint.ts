import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { registerAppRoute } from '../../harnesses/appMcpLauncher.js'
import type { ChildProcessEnvironment } from '../../harnesses/port.js'
import { readProductEnvironment } from '@foreman-code/contracts/product-environment'
import { AgentFilePublishInputSchema, AgentFilePublishResultSchema, type AgentFilePublishInput, type AgentFilePublishResult } from '@foreman-code/contracts/files'
import { TransferIntentSchema } from '@foreman-code/contracts/byte-transfer'
import { WorkerMcpRelayResponseSchema } from '@foreman-code/contracts/worker-mcp-relay'
import { z } from 'zod'

const PublicationCall = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number().int()]),
  method: z.literal('tools/call'), params: z.object({ name: z.literal('files.publish_transferred_result'),
    arguments: z.object({ transferId: TransferIntentSchema.shape.transferId, publication: AgentFilePublishInputSchema }).strict() }) })
const PublicationReply = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number().int()]),
  result: z.object({ isError: z.boolean().optional(), structuredContent: AgentFilePublishResultSchema }) })

/** Called only on the authenticated Main relay response, before forwarding it
 * to the native client. Model text and arbitrary loopback responses are absent. */
export function observedWorkflowArtifactPublication(body: unknown, response: z.infer<typeof WorkerMcpRelayResponseSchema>) {
  const call = PublicationCall.safeParse(body)
  if (!call.success || response.statusCode !== 200 || response.contentType === 'empty') return undefined
  const messages = response.contentType === 'application/json' ? [response.body]
    : response.body.split(/\r?\n\r?\n/).map(event => event.split(/\r?\n/)
      .filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')).filter(Boolean)
  const replies = messages.flatMap(message => {
    try { const reply = PublicationReply.safeParse(JSON.parse(message)); return reply.success ? [reply.data] : [] }
    catch { return [] }
  }).filter(reply => reply.id === call.data.id && !reply.result.isError)
  if (replies.length !== 1) return undefined
  return { input: call.data.params.arguments, result: replies[0]!.result.structuredContent }
}

/** The admitted worker owns this private route until its original native owner closes.
 * Main reauthorizes every relayed request; neither this endpoint nor its route file grants access. */
export async function createWorkerMcpEndpoint(input: {
  relay: { environment: ChildProcessEnvironment; expiresAt: string;
    request(body: unknown, protocolVersion?: string, signal?: AbortSignal): Promise<z.infer<typeof WorkerMcpRelayResponseSchema>> }
  launcher: string
  signal: AbortSignal
  onArtifactPublication?(input: { transferId: string; publication: AgentFilePublishInput }, result: AgentFilePublishResult): void
}) {
  input.signal.throwIfAborted()
  const expiresAt = input.relay.expiresAt
  const token = readProductEnvironment(input.relay.environment.variables, 'MCP_TOKEN')
  if (!token || Date.parse(expiresAt) <= Date.now()) throw new Error('The original Main MCP lease is unavailable.')
  const digest = createHash('sha256').update(`Bearer ${token}`).digest()
  const active = new Set<Promise<void>>()
  let closing = false, shutdown: Promise<void> | undefined
  const server = createServer((request, response) => {
    const task = (async () => {
      response.setHeader('cache-control', 'no-store')
      if (closing || Date.parse(expiresAt) <= Date.now()
        || !timingSafeEqual(digest, createHash('sha256').update(request.headers.authorization ?? '').digest())) {
        response.writeHead(401); response.end(); return
      }
      if (request.method !== 'POST' || request.url !== '/mcp') { response.writeHead(405); response.end(); return }
      const controller = new AbortController()
      const disconnected = () => controller.abort()
      request.once('aborted', disconnected)
      response.once('close', disconnected)
      try {
        let byteSize = 0
        const chunks: Buffer[] = []
        for await (const chunk of request) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          byteSize += bytes.byteLength
          if (byteSize > 1_000_000) { response.writeHead(413); response.end(); return }
          chunks.push(bytes)
        }
        let body: unknown
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
        catch { response.writeHead(400); response.end(); return }
        const protocol = request.headers['mcp-protocol-version']
        if (Array.isArray(protocol) || (protocol?.length ?? 0) > 64) { response.writeHead(400); response.end(); return }
        const result = await input.relay.request(body, protocol, controller.signal)
        controller.signal.throwIfAborted()
        const publication = input.onArtifactPublication && observedWorkflowArtifactPublication(body, result)
        if (publication) input.onArtifactPublication!(publication.input, publication.result)
        response.writeHead(result.statusCode, result.contentType === 'empty' ? {} : { 'content-type': result.contentType })
        response.end(result.body)
      } finally { request.removeListener('aborted', disconnected); response.removeListener('close', disconnected) }
    })().catch(() => { if (!response.headersSent) response.writeHead(502); response.end() })
    active.add(task)
    void task.then(() => active.delete(task))
  })
  server.requestTimeout = 15_000
  server.headersTimeout = 10_000
  server.keepAliveTimeout = 1000
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() }) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('The private worker MCP listener is unavailable.')
  const endpoint = `http://127.0.0.1:${address.port}/mcp`
  let unregister: (() => Promise<void>) | undefined
  const close = () => shutdown ??= (async () => {
    closing = true
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await Promise.all([...active])
    await unregister?.()
  })()
  try {
    input.signal.throwIfAborted()
    unregister = await registerAppRoute(token, endpoint, expiresAt, input.launcher)
    input.signal.throwIfAborted()
  } catch (error) { await close(); throw error }
  return { endpoint, close }
}
