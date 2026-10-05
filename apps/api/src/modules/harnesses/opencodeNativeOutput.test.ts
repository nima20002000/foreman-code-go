import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import type { TemporaryFileScope } from '@foreman-code/contracts/files'
import type { OpenCodeServerController } from './opencodeTransport.js'
import { createBufferedNativeOutputs, NativeOutputMemoryBudget } from '../runs/remote/bufferedNativeOutput.js'
import { openOpenCodeNativeOutputTurn } from './opencodeNativeOutput.js'

it('uses authenticated turn-scoped HTTP tools for OpenCode and seals through the shared producer', async () => {
  const scope: TemporaryFileScope = { kind: 'temporary', chat: { kind: 'agent', conversationId: 'conversation',
    workspaceId: 'workspace', workflowId: 'workflow', agentId: 'agent', runId: 'run', executionId: 'execution' } }
  let active = true
  const pin = { session: { harness: 'opencode' as const, providerVersion: '1.18.31', nativeSessionId: 'session' },
    connectionId: 'connection', runtimeGeneration: 1, nativeTurnId: 'turn', assertCurrent() {
      if (!active) throw new Error('Original native turn closed')
    } }
  const outputs = createBufferedNativeOutputs({ budget: new NativeOutputMemoryBudget(),
    assertQualified: async () => {}, assertCurrent: async () => {}, authorize: async () => scope,
    publish: async () => { throw new Error('No publication in protocol test') } }).opencode
  const bridge = await outputs.prepare({ configuration: DEFAULT_HARNESS_DEFAULTS.opencode,
    providerVersion: '1.18.31', directory: '/project', session: pin.session, clientCorrelationId: 'execution:execution',
    connectionId: pin.connectionId, runtimeGeneration: 1 }, new AbortController().signal)
  let registration: { name: string; config: { url: string; headers: { Authorization: string } } } | undefined
  let disconnected = false
  const server = { expectedVersion: '1.18.31', generation: 1,
    async request(path: string, request?: RequestInit) {
      if (path.startsWith('/mcp?')) registration = JSON.parse(String(request?.body)) as typeof registration
      if (path.includes('/disconnect?')) disconnected = true
      return new Response('{}', { status: 200 })
    } } as unknown as OpenCodeServerController
  const turn = await openOpenCodeNativeOutputTurn({ bridge, server, pin, directory: '/project', signal: new AbortController().signal })
  try {
    if (!registration) throw new Error('Native MCP registration missing')
    const call = async (name: string, args: unknown, token = registration!.config.headers.Authorization) => {
      const response = await fetch(registration!.config.url, { method: 'POST', headers: { Authorization: token,
        'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: args } }) })
      const text = await response.text()
      if (response.status !== 200) return { status: response.status, result: undefined }
      const message = text.startsWith('event:') ? text.split('\n').find(line => line.startsWith('data:'))!.slice(5) : text
      return { status: response.status, result: (JSON.parse(message) as { result: {
        isError?: boolean; structuredContent?: { artifactId?: string; operation?: string; byteSize?: number }
      } }).result }
    }
    const create = { operation: 'create', commandId: randomUUID(), filename: 'report.md', mediaType: 'text/markdown' }
    expect((await call('files.native_output_create', create, 'Bearer foreign')).status).toBe(401)
    const immediate = call('files.native_output_create', create)
    await turn.activate()
    const created = await immediate
    expect(created.result?.structuredContent?.operation).toBe('create')
    const artifactId = created.result?.structuredContent?.artifactId
    expect((await call('files.native_output_append', { operation: 'append', commandId: randomUUID(), artifactId,
      offset: 0, contentBase64: Buffer.from('native output').toString('base64') })).result?.structuredContent?.byteSize).toBe(13)
    expect((await call('files.native_output_seal', { operation: 'seal', commandId: randomUUID(), artifactId }))
      .result?.structuredContent?.operation).toBe('seal')
    active = false
    expect((await call('files.native_output_create', { ...create, commandId: randomUUID() })).result?.isError).toBe(true)
  } finally { await turn.close() }
  expect(disconnected).toBe(true)
})
