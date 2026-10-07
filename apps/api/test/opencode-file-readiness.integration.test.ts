import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { expect, it, vi } from 'vitest'
import { MAX_FILE_BYTES, MAX_MESSAGE_ATTACHMENTS } from '@foreman-code/contracts/files'
import { DomainError } from '../src/modules/errors.js'
import { registerFileToolsMcp, mountOpenCodeFileMcp } from '../src/modules/files/tools/mcp.js'
import { OpenCodeNativeSessionManager } from '../src/modules/harnesses/opencodeServer.js'
import { ManagedOpenCodeServer } from '../src/modules/harnesses/opencodeTransport.js'
import { LocalOpenCodeExecutionFiles } from '../src/modules/harnesses/opencodeFiles/host.js'
import type { OpenCodeChatFiles } from '../src/modules/harnesses/opencodeFiles/chat.js'
import { configuration, request } from './opencode-fixtures.js'
import { fileToolFixture } from './support/fileTools.js'

function barrier() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

// The installed executable resolves MCP tools and sends the first request to a loopback model.
it('waits for the file manifest before the first native model request and keeps file calls behind acknowledgement',
  async () => {
    const f = await fileToolFixture()
    f.advance(Date.now() - f.clock().getTime())
    const source = await f.upload()
    const directory = await mkdtemp(join(tmpdir(), 'opencode-file-readiness-'))
    const fileRoot = join(directory, 'files')
    await mkdir(fileRoot, { mode: 0o700 })
    const app = Fastify()
    app.setErrorHandler((error, _request, reply) => reply.code(error instanceof DomainError ? error.status : 500)
      .send({ error: 'Request denied.' }))
    registerFileToolsMcp(app, f.service)
    const manifestRequested = barrier()
    const manifestReady = barrier()
    const acknowledgeRequested = barrier()
    const acknowledgementReady = barrier()
    const modelRequested = barrier()
    const modelResponseReady = barrier()
    const fileCallRequested = barrier()
    let connectionToken = ''
    let modelTools: string[] = []
    app.addHook('preHandler', async (incoming) => {
      if (!incoming.url.startsWith('/mcp/files/opencode/')) return
      connectionToken = incoming.headers.authorization!.slice('Bearer '.length)
      if ((incoming.body as { method?: string }).method === 'tools/list') {
        manifestRequested.release()
        await manifestReady.promise
      }
      if ((incoming.body as { method?: string }).method === 'tools/call') fileCallRequested.release()
    })
    app.post('/v1/chat/completions', async (incoming, reply) => {
      const body = incoming.body as { tools?: { function: { name: string } }[] }
      modelTools = (body.tools ?? []).map((tool) => tool.function.name)
      modelRequested.release()
      await modelResponseReady.promise
      reply.hijack()
      reply.raw.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const [delta, finish] of [[{ role: 'assistant', content: 'Ready.' }, null], [{}, 'stop']]) {
        reply.raw.write(`data: ${JSON.stringify({ id: 'completion', object: 'chat.completion.chunk',
          created: 1, model: 'manifest', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
      }
      reply.raw.end('data: [DONE]\n\n')
    })
    const origin = await app.listen({ host: '127.0.0.1', port: 0 })
    vi.stubEnv('OPENCODE_CONFIG_CONTENT', JSON.stringify({
        model: 'fixture/manifest', small_model: 'fixture/manifest', enabled_providers: ['fixture'],
        provider: { fixture: { npm: '@ai-sdk/openai-compatible', name: 'Manifest fixture',
          options: { baseURL: `${origin}/v1`, apiKey: 'loopback-fixture' },
          models: { manifest: { name: 'manifest', limit: { context: 1_000_000, output: 1000 } } } } },
      }))
    vi.stubEnv('XDG_CONFIG_HOME', join(directory, 'config'))
    vi.stubEnv('XDG_DATA_HOME', join(directory, 'data'))
    vi.stubEnv('XDG_CACHE_HOME', join(directory, 'cache'))
    vi.stubEnv('XDG_STATE_HOME', join(directory, 'state'))
    const environment = { agentId: 'agent-a', variables: {} }
    const server = new ManagedOpenCodeServer({ binary: process.env.OPENCODE_BINARY ?? 'opencode',
      workingDirectory: directory, ownerAgentId: 'agent-a', environment, pure: true, appMcpAccess: 'none' })
    const host = new LocalOpenCodeExecutionFiles({ executionHostId: 'fixture-host', root: fileRoot,
      maxFileBytes: MAX_FILE_BYTES, async assertSourceIsolation() {
        // All source bytes live only in MemoryBytes; no filesystem vault exists in this fixture.
        expect(f.bytes.objects.size).toBeGreaterThan(0)
      } })
    const mountId = randomUUID()
    const runtime: OpenCodeChatFiles = { async resolve(identity) {
      const context = { ...f.context, nativeSessionId: identity.nativeSessionId,
        turnId: identity.nativeTurnId, messageId: 'accepted-message' }
      return {
        admission: { context, attachments: [source], directory, executionHostId: host.executionHostId,
          mode: 'write', expiresAt: new Date(Date.now() + 60_000) },
        options: { service: f.service, host, endpoint: `${origin}/mcp/files/opencode/${mountId}`,
          maxFileBytes: MAX_FILE_BYTES, maxAttachments: MAX_MESSAGE_ATTACHMENTS },
        read: (input) => f.service.readAccepted(context, input),
        adoptPublished: async () => {},
        mount: async (facade) => {
          const unmount = mountOpenCodeFileMcp(app, mountId, facade)
          return async () => { unmount() }
        },
      }
    } }
    const manager = new OpenCodeNativeSessionManager({ server, ownerAgentId: 'agent-a',
      appMcpAccess: 'none', chatFiles: runtime })
    let running: Promise<void> | undefined
    let read: Promise<{ status: number; body: string }> | undefined
    try {
      const harness = { ...configuration(), model: 'fixture/manifest', variant: '' }
      const nativeRequest = { ...request(harness), workingDirectory: directory, runtimeDirectory: directory }
      const session = await manager.createSession({ request: nativeRequest, environment })
      const health = await server.request('/global/health')
      expect(health.ok).toBe(true)
      expect(await health.json()).toMatchObject({ healthy: true, version: session.providerVersion })
      running = (async () => {
        const observer = manager.startTurn(session, { prompt: 'Say ready.',
          clientCorrelationId: 'manifest-turn', onSubmitted: async () => {
            acknowledgeRequested.release()
            await acknowledgementReady.promise
          } }, AbortSignal.timeout(45_000))[Symbol.asyncIterator]()
        while (!(await observer.next()).done) { /* consume the native turn */ }
      })()
      const progress = async (pending: Promise<void>) => {
        await Promise.race([pending, running!.then(() => { throw new Error('Native turn ended before the barrier.') })])
      }
      await progress(manifestRequested.promise)
      expect(modelTools).toEqual([])
      expect(f.tools.sessions.size).toBe(1) // Only the fixture's original credential exists.
      await expect(f.sessions.authenticate(connectionToken)).rejects.toMatchObject({ code: 'FILE_SESSION_EXPIRED' })
      const denied = await app.inject({ method: 'POST', url: `/mcp/files/opencode/${mountId}`,
        headers: { authorization: `Bearer ${f.token}` }, payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })
      expect(denied.statusCode).toBe(401)
      manifestReady.release()
      await progress(acknowledgeRequested.promise)
      let readFinished = false
      read = fetch(`${origin}/mcp/files/opencode/${mountId}`, { method: 'POST', headers: {
        authorization: `Bearer ${connectionToken}`, 'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'files.read', arguments: source } }), signal: AbortSignal.timeout(45_000) })
        .then(async (response) => ({ status: response.status, body: await response.text() }))
      read.then(() => { readFinished = true }, () => { readFinished = true })
      await progress(fileCallRequested.promise)
      await progress(modelRequested.promise)
      expect(modelTools.some((name) => name.endsWith('_files_read'))).toBe(true)
      expect(modelTools.some((name) => name.endsWith('_files_publish_result'))).toBe(true)
      expect(readFinished).toBe(false)
      expect(f.tools.sessions.size).toBe(1)
      acknowledgementReady.release()
      const response = await read
      expect(response.status).toBe(200)
      expect(response.body).toContain('contentBase64')
      modelResponseReady.release()
      await running
    } finally {
      manifestReady.release()
      acknowledgementReady.release()
      modelResponseReady.release()
      await manager.dispose()
      await Promise.allSettled([running, read])
      await app.close()
      vi.unstubAllEnvs()
      await rm(directory, { recursive: true, force: true })
    }
  }, 60_000)
