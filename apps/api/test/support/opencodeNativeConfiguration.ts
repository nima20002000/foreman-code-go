import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { vi } from 'vitest'
import type { OpenCodeHarnessConfiguration } from '@graphql/contracts'
import type { OpenCodeChatFiles } from '../../src/modules/harnesses/opencodeFiles/chat.js'
import type { OpenCodeServerController } from '../../src/modules/harnesses/opencodeTransport.js'
import type { OpenCodeNativeSessionManager } from '../../src/modules/harnesses/opencodeServer.js'
import { ManagedOpenCodeServer } from '../../src/modules/harnesses/opencodeTransport.js'
import { NativeHarnessFactories } from '../../src/modules/harnesses/runtimeFactory.js'
import { nativeMessageId, object, parseOpenCodeSse } from '../../src/modules/harnesses/opencodeProtocol.js'
import type { WorkflowNativeSessionStart } from '../../src/modules/harnesses/port.js'
import { configuration, request } from '../opencode-fixtures.js'

// Only the model response is deterministic; factory, transport, native storage and controls are real.
export interface NativeModelCall { model: string; messages: { role: string; content: unknown }[] }
export async function nativeConfigurationFixture(options: {
  files?: boolean
  respond?: (call: NativeModelCall, index: number) => Promise<string>
  beforeFinish?: (call: NativeModelCall, index: number) => Promise<void>
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'opencode-native-configuration-'))
  const workspaceRoot = join(directory, 'workspace')
  const vault = join(directory, 'vault')
  if (options.files) await mkdir(workspaceRoot, { mode: 0o700 })
  const model = Fastify({ bodyLimit: 32 * 1024 * 1024 })
  const calls: NativeModelCall[] = []
  model.post('/v1/chat/completions', async (request, reply) => {
    const body = request.body as (typeof calls)[number]
    calls.push(body)
    const index = calls.length
    reply.hijack()
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream' })
    const emit = (delta: unknown, finishReason: string | null) => reply.raw.write(`data: ${JSON.stringify({
      id: 'completion', object: 'chat.completion.chunk', created: 1, model: body.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`)
    const content = options.respond ? await options.respond(body, index) : 'Completed.'
    emit({ role: 'assistant', content }, null)
    await options.beforeFinish?.(body, index)
    emit({}, 'stop')
    reply.raw.end('data: [DONE]\n\n')
  })
  const managers: OpenCodeNativeSessionManager[] = []
  const servers: ManagedOpenCodeServer[] = []
  try {
    const origin = await model.listen({ host: '127.0.0.1', port: 0 })
    for (const name of ['CONFIG', 'DATA', 'CACHE', 'STATE']) {
      vi.stubEnv(`XDG_${name}_HOME`, join(directory, name.toLowerCase()))
    }
    vi.stubEnv('OPENCODE_CONFIG', undefined)
    vi.stubEnv('OPENCODE_CONFIG_DIR', undefined)
    vi.stubEnv('OPENCODE_CONFIG_CONTENT', JSON.stringify({
      model: 'fixture/parent', small_model: 'fixture/parent', default_agent: 'parent', enabled_providers: ['fixture'],
      provider: { fixture: { npm: '@ai-sdk/openai-compatible', name: 'Configuration fixture',
        options: { baseURL: `${origin}/v1`, apiKey: 'loopback-fixture' },
        models: Object.fromEntries(['parent', 'child'].map(name => [name, {
          name, limit: { context: 1_000_000, output: 1000 },
          modalities: { input: ['text', 'image'], output: ['text'] },
          variants: { focused: { temperature: 0.1 }, default: { temperature: 0.2 } },
        }])),
      } },
      agent: {
        parent: { mode: 'primary', model: 'fixture/parent', permission: { '*': 'deny' } },
        reviewer: { mode: 'subagent', model: 'fixture/child', variant: 'focused',
          prompt: 'Follow the child instructions.', permission: { '*': 'deny' } },
      },
    }))
    const factory = new NativeHarnessFactories({
      codexBinary: 'codex', openCodeBinary: process.env.OPENCODE_BINARY ?? 'opencode',
      ...(options.files ? { workspaceRoot, openCodeFileStorageRoot: vault } : {}),
    }, { mode: 'native', openCodeServer: options => {
      const server = new ManagedOpenCodeServer({ ...options, pure: true })
      servers.push(server)
      return server
    } })
    const harness: OpenCodeHarnessConfiguration = {
      ...configuration(), model: 'fixture/parent', nativeAgent: 'parent', variant: '',
    }
    const start = (configuration = harness): WorkflowNativeSessionStart => ({ request: {
      ...request(configuration), workingDirectory: directory, runtimeDirectory: directory,
    } })
    const allocate = (ownerAgentId = 'agent-1') => {
      const allocation = factory.allocate({ harness: 'opencode', role: 'workflow',
        workingDirectory: directory, ownerAgentId, appMcpAccess: 'none' })
      assert(allocation.harness === 'opencode')
      managers.push(allocation.manager)
      return { native: allocation.manager, server: servers.at(-1)! }
    }
    const allocateChat = (workingDirectory: string, ownerAgentId: string,
      chatFiles: (server: OpenCodeServerController) => OpenCodeChatFiles) => {
      const allocation = factory.allocate({ harness: 'opencode', role: 'agent-chat', workingDirectory,
        ownerAgentId, appMcpAccess: 'none', chatFiles })
      assert(allocation.harness === 'opencode')
      managers.push(allocation.manager)
      return { native: allocation.manager, server: servers.at(-1)! }
    }
    const close = async () => {
      try {
        const results = await Promise.allSettled(managers.map(manager => manager.dispose()))
        const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
        if (errors.length) throw new AggregateError(errors, 'Native fixture disposal failed.')
      } finally {
        await model.close()
        vi.unstubAllEnvs()
        await rm(directory, { recursive: true, force: true })
      }
    }
    return { directory, workspaceRoot, vault, calls, harness, start, allocate, allocateChat, close }
  } catch (error) {
    await model.close()
    vi.unstubAllEnvs()
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

export async function nativeJson(server: ManagedOpenCodeServer, directory: string, path: string,
  body?: Record<string, unknown>) {
  const url = new URL(path, 'http://native.invalid')
  url.searchParams.set('directory', directory)
  const init: RequestInit = body === undefined ? { method: 'GET' } : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }
  const response = await server.request(`${url.pathname}${url.search}`, init, AbortSignal.timeout(30_000))
  assert.equal(response.ok, true, `Native request failed: ${path} (${response.status})`)
  return object(await response.json())
}

export function nativePrompt(correlation: string, modelID: string, text: string) {
  return { messageID: nativeMessageId(correlation), agent: 'reviewer',
    model: { providerID: 'fixture', modelID }, parts: [{ type: 'text', text }] }
}

export async function withNativeUserMessage(server: ManagedOpenCodeServer, directory: string,
  sessionID: string, messageID: string, submit: () => Promise<void>) {
  const signal = AbortSignal.timeout(30_000)
  const response = await server.request(`/event?directory=${encodeURIComponent(directory)}`, {
    headers: { accept: 'text/event-stream' },
  }, signal)
  assert(response.ok && response.body)
  try {
    await submit()
    for await (const event of parseOpenCodeSse(response.body, signal)) {
      const info = object(object(event.properties).info)
      if (event.type === 'message.updated' && info.sessionID === sessionID && info.id === messageID
        && info.role === 'user') return
    }
    assert.fail('Native event stream ended before the child user message was persisted.')
  } finally {
    await response.body.cancel()
  }
}
