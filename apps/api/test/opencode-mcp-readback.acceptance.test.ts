import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { expect, it } from 'vitest'
import { AppInteractionGetOutputSchema, NATIVE_INTERACTION_FIXTURES } from '@graphql/contracts'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import { buildApp } from '../src/app.js'
import type { PostgresAccessService } from '../src/modules/access/postgres.js'
import { DomainError } from '../src/modules/errors.js'
import { PostgresAppInteractionService } from '../src/modules/interactions/app.js'
import { TEXT_MIRROR_BYTES } from '../src/mcp/shared/results.js'

interface CompletionRequest {
  tools?: { function: { name: string } }[]
  messages: { role: string; content: string; tool_call_id?: string }[]
}

// Uses the installed OpenCode executable and a loopback model to exercise its MCP conversion and truncation.
it.each([TEXT_MIRROR_BYTES - 1, TEXT_MIRROR_BYTES + 1])(
  'keeps identity, response options and working content retrieval visible to OpenCode for %i-byte results', async (bytes) => {
    const source = NATIVE_INTERACTION_FIXTURES.opencode
    const empty = { interaction: { ...source, request: { patch: '' } } }
    const interaction = { ...source, request: {
      patch: 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify(empty), 'utf8')),
    } }
    expect(Buffer.byteLength(JSON.stringify({ interaction }), 'utf8')).toBe(bytes)
    const principal: ManagementPrincipal = {
      id: 'native-readback-reader', name: 'Reader', audience: 'worker', agentId: 'reader-agent',
      expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null,
      grants: [{ actions: ['interactions:read'], scope: {
        workspaceIds: [interaction.workspaceId], workflowIds: [interaction.workflowId], runIds: [interaction.runId],
      } }],
    }
    const service = new PostgresAppInteractionService({ query: async () => ({ rows: [{
      role: 'coder', defaults: ['interaction_get'], override: null,
    }] }) } as unknown as pg.Pool, { get: async () => interaction } as never, {} as never)
    const access = { authenticate: async (token: string) => {
      if (token !== 'native-readback-token') throw new DomainError('AUTH_INVALID', 'Invalid credential.', 401)
      return principal
    } } as unknown as PostgresAccessService
    const app = buildApp({
      readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      appMcp: { access, interactions: service },
    })
    const visible: ReturnType<typeof AppInteractionGetOutputSchema.parse>[] = []
    app.post('/v1/chat/completions', async (request, reply) => {
      const body = request.body as CompletionRequest
      const previous = body.messages.filter((message) => message.role === 'tool'
        && message.tool_call_id?.startsWith('readback-'))
      const tool = body.tools?.find((item) => item.function.name === 'fixture_interaction_get')
      reply.hijack()
      reply.raw.writeHead(200, { 'content-type': 'text/event-stream' })
      const emit = (delta: unknown, finishReason: string | null) => reply.raw.write(`data: ${JSON.stringify({
        id: 'completion', object: 'chat.completion.chunk', created: 1, model: 'readback',
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`)
      if (!tool) {
        emit({ role: 'assistant', content: 'Readback' }, null)
        emit({}, 'stop')
      } else if (previous.length < 2) {
        const args: { interactionId: string; contentCursor?: string } = { interactionId: interaction.id }
        if (previous.length === 1) {
          const page = AppInteractionGetOutputSchema.parse(JSON.parse(previous[0]!.content))
          visible.push(page)
          args.contentCursor = page.content!.nextCursor!
        }
        emit({ role: 'assistant', tool_calls: [{ index: 0, id: `readback-${previous.length + 1}`,
          type: 'function', function: { name: tool.function.name, arguments: JSON.stringify(args) } }] }, null)
        emit({}, 'tool_calls')
      } else {
        visible.push(AppInteractionGetOutputSchema.parse(JSON.parse(previous.at(-1)!.content)))
        emit({ role: 'assistant', content: 'Readback complete.' }, null)
        emit({}, 'stop')
      }
      reply.raw.end('data: [DONE]\n\n')
    })
    const directory = await mkdtemp(join(tmpdir(), 'opencode-mcp-readback-'))
    try {
      const origin = await app.listen({ host: '127.0.0.1', port: 0 })
      const config = {
        model: 'fixture/readback', small_model: 'fixture/readback', enabled_providers: ['fixture'],
        provider: { fixture: { npm: '@ai-sdk/openai-compatible', name: 'Readback fixture',
          options: { baseURL: `${origin}/v1`, apiKey: 'loopback-fixture' },
          models: { readback: { name: 'readback', limit: { context: 1_000_000, output: 1000 } } },
        } },
        mcp: { fixture: { type: 'remote', url: `${origin}/mcp`,
          headers: { Authorization: 'Bearer native-readback-token' }, enabled: true } },
        agent: { readback: { mode: 'primary', permission: { '*': 'deny', fixture_interaction_get: 'allow' } } },
      }
      const child = spawn(process.env.OPENCODE_BINARY ?? 'opencode', [
        'run', '--model', 'fixture/readback', '--agent', 'readback', '--format', 'json', 'Read the interaction.',
      ], { cwd: directory, timeout: 45_000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'], env: {
        PATH: process.env.PATH, OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
        XDG_CONFIG_HOME: join(directory, 'config'), XDG_DATA_HOME: join(directory, 'data'),
        XDG_CACHE_HOME: join(directory, 'cache'), XDG_STATE_HOME: join(directory, 'state'),
      } })
      let output = ''
      child.stdout.on('data', (chunk) => { output += chunk.toString() })
      child.stderr.on('data', (chunk) => { output += chunk.toString() })
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', resolve)
      })
      expect(code, output.slice(-4000)).toBe(0)
      expect(visible).toHaveLength(2)
      for (const page of visible) {
        expect(page.interaction).toMatchObject({ id: interaction.id, revision: interaction.revision,
          responseOptions: interaction.responseOptions, contentOmitted: true })
        expect(page.content!.nextCursor).toEqual(expect.any(String))
      }
      expect(visible[0]!.content!.text + visible[1]!.content!.text)
        .toBe(JSON.stringify({ interaction }).slice(0,
          visible[0]!.content!.text.length + visible[1]!.content!.text.length))
    } finally {
      await app.close()
      await rm(directory, { recursive: true, force: true })
    }
  }, 60_000,
)
