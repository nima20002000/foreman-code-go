import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { registerAppRoute } from '../../harnesses/appMcpLauncher.js'
import type { ChildProcessEnvironment } from '../../harnesses/port.js'
import { readProductEnvironment } from '@foreman-code/contracts/product-environment'
import { AgentFilePublishInputSchema, AgentFilePublishResultSchema, type AgentFilePublishInput, type AgentFilePublishResult } from '@foreman-code/contracts/files'
import { TransferIntentSchema } from '@foreman-code/contracts/byte-transfer'
import { WorkerMcpRelayResponseSchema } from '@foreman-code/contracts/worker-mcp-relay'
import { z } from 'zod'
import { componentLogger } from '../../diagnostics/logger.js'

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
export interface WorkerMcpRelay {
  environment: ChildProcessEnvironment
  expiresAt: string
  request(body: unknown, protocolVersion?: string, signal?: AbortSignal): Promise<z.infer<typeof WorkerMcpRelayResponseSchema>>
  /** Renews the same scoped lease with Main and returns its new expiry. */
  refresh?(signal?: AbortSignal): Promise<string>
}

interface WorkerMcpEndpointOptions {
  launcher: string
  signal: AbortSignal
  onArtifactPublication?(input: { transferId: string; publication: AgentFilePublishInput }, result: AgentFilePublishResult): void
}

export async function createWorkerMcpEndpoint(input: WorkerMcpEndpointOptions & { relay: WorkerMcpRelay }) {
  const endpoint = await createUnboundWorkerMcpEndpoint(input)
  try { await endpoint.bindRelay(input.relay); return endpoint }
  catch (error) { await endpoint.close(); throw error }
}

/** Inspection keeps a stable native URL; requests remain unauthorized until Main supplies its scoped lease. */
export async function createUnboundWorkerMcpEndpoint(input: WorkerMcpEndpointOptions) {
  input.signal.throwIfAborted()
  const log = componentLogger('harness')
  const logFailure = (operation: string, error: unknown) => {
    log.error({ operation, launcher: input.launcher,
      code: error instanceof Error && 'code' in error ? error.code : undefined,
      errorType: error instanceof Error ? error.name : typeof error }, 'Worker MCP relay failed')
  }
  let bound: { relay: WorkerMcpRelay; digest: Buffer; expiresAt: string } | undefined
  const active = new Set<Promise<void>>()
  let closing = false, shutdown: Promise<void> | undefined
  const server = createServer((request, response) => {
    const task = (async () => {
      response.setHeader('cache-control', 'no-store')
      const lease = bound
      if (closing || !lease || Date.parse(lease.expiresAt) <= Date.now()
        || !timingSafeEqual(lease.digest, createHash('sha256').update(request.headers.authorization ?? '').digest())) {
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
        const result = await lease.relay.request(body, protocol, controller.signal)
        if (bound !== lease || closing) throw new Error('The Main MCP lease changed during the request.')
        controller.signal.throwIfAborted()
        const publication = input.onArtifactPublication && observedWorkflowArtifactPublication(body, result)
        if (publication) input.onArtifactPublication!(publication.input, publication.result)
        response.writeHead(result.statusCode, result.contentType === 'empty' ? {} : { 'content-type': result.contentType })
        response.end(result.body)
      } finally { request.removeListener('aborted', disconnected); response.removeListener('close', disconnected) }
    })().catch(error => {
      logFailure('request', error)
      if (!response.headersSent) response.writeHead(502)
      response.end()
    })
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
    await updates
    await unregister?.()
  })()
  let updates: Promise<void> = Promise.resolve()
  const bindRelay = (relay: WorkerMcpRelay) => {
    const task = updates.then(async () => {
      input.signal.throwIfAborted()
      const token = readProductEnvironment(relay.environment.variables, 'MCP_TOKEN')
      if (closing || !token || !Number.isFinite(Date.parse(relay.expiresAt)) || Date.parse(relay.expiresAt) <= Date.now()) {
        throw new Error('The original Main MCP lease is unavailable.')
      }
      bound = undefined
      await unregister?.()
      unregister = undefined
      const release = await registerAppRoute(token, endpoint, relay.expiresAt, input.launcher)
      if (closing || input.signal.aborted) {
        await release()
        throw new Error('The private worker MCP listener closed.')
      }
      unregister = release
      bound = { relay, digest: createHash('sha256').update(`Bearer ${token}`).digest(), expiresAt: relay.expiresAt }
      log.info({ agentId: relay.environment.agentId, launcher: input.launcher, expiresAt: relay.expiresAt },
        'Worker MCP launcher route registered')
    }).catch(error => {
      logFailure('register', error)
      throw error
    })
    updates = task.then(() => undefined, () => undefined)
    return task
  }
  /** Long native turns renew the bound lease in place; the native URL and bearer stay the same. */
  const refreshLease = () => {
    const task = updates.then(async () => {
      const lease = bound
      if (closing || !lease?.relay.refresh) throw new Error('The original worker MCP endpoint is closing.')
      const renewedExpiry = await lease.relay.refresh(input.signal)
      input.signal.throwIfAborted()
      if (closing || bound !== lease) throw new Error('The original worker MCP endpoint is closing.')
      if (!Number.isFinite(Date.parse(renewedExpiry)) || Date.parse(renewedExpiry) <= Date.now()) {
        throw new Error('The renewed Main MCP lease is unavailable.')
      }
      const token = readProductEnvironment(lease.relay.environment.variables, 'MCP_TOKEN')!
      unregister = await registerAppRoute(token, endpoint, renewedExpiry, input.launcher)
      lease.expiresAt = renewedExpiry
      log.debug({ agentId: lease.relay.environment.agentId, launcher: input.launcher, expiresAt: renewedExpiry },
        'Worker MCP launcher route renewed')
      return renewedExpiry
    }).catch(error => {
      logFailure('renew', error)
      throw error
    })
    updates = task.then(() => undefined, () => undefined)
    return task
  }
  return { endpoint, bindRelay, refreshLease, close }
}
