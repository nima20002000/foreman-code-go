import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { MAX_FILE_BYTES } from '@foreman-code/contracts/files'
import { WORKER_MCP_EXTENSION } from '@foreman-code/contracts/worker-mcp-relay'
import type { DeviceApplicationRequestOptions } from '../devices/deviceApplicationChannel.js'
import { prepareWorkerConversationMcp } from './workerMcpAccess.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'
import { createWorkerMcpEndpoint } from '../runs/remote/workerMcpEndpoint.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(close => close())) })

function referenceCall(byteSize: number) {
  const bytes = Buffer.alloc(byteSize, 97)
  return { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'reference_file_add', arguments: {
    scope: { kind: 'workspace_reference', workspaceId: 'workspace' },
    upload: { requestId: randomUUID(), filename: 'reference.pdf', mediaType: 'application/pdf',
      byteSize, sha256: createHash('sha256').update(bytes).digest('hex') }, contentBase64: bytes.toString('base64'),
  } } }
}

it('carries an advertised full-size reference through the bounded Worker channel request', async () => {
  const f = workerConversationFixture()
  const call = referenceCall(MAX_FILE_BYTES)
  let received: unknown
  const relay = await prepareWorkerConversationMcp({ source: { method: 'conversation.status',
    binding: { ...f.binding, appMcpAccess: 'scoped' }, admissionId: randomUUID() },
  token: 'operator-token', signal: new AbortController().signal,
  request: async (_namespace, raw, options: DeviceApplicationRequestOptions) => {
    const payload = raw as { operation: string; body?: unknown }
    if (payload.operation === 'conversation-mcp.authorize') {
      return { payload: { expiresAt: new Date(Date.now() + 600_000).toISOString() } }
    }
    expect(Buffer.byteLength(JSON.stringify(raw))).toBeLessThanOrEqual(WORKER_MCP_EXTENSION.maxJsonBytes)
    expect(options.bytes?.byteLength ?? 0).toBeLessThanOrEqual(WORKER_MCP_EXTENSION.maxBinaryBytes)
    received = options.bytes ? JSON.parse(Buffer.from(options.bytes).toString('utf8')) : payload.body
    return { payload: { statusCode: 200, contentType: 'application/json', body: '{"result":"stored"}' } }
  } })
  expect(await relay.request(call)).toMatchObject({ statusCode: 200, body: '{"result":"stored"}' })
  expect(received).toEqual(call)
})

it('accepts a reference larger than one MiB on the authenticated private HTTP endpoint', async () => {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'worker-reference-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const call = referenceCall(1024 * 1024)
  let received: unknown
  const endpoint = await createWorkerMcpEndpoint({ launcher: join(directory, 'launcher.mjs'),
    signal: new AbortController().signal, relay: {
      environment: { agentId: 'operator', variables: { FOREMAN_CODE_MCP_TOKEN: 'operator-token' } },
      expiresAt: new Date(Date.now() + 600_000).toISOString(), request: async body => {
        received = body
        return { statusCode: 200, contentType: 'application/json', body: '{"result":"stored"}' }
      },
    } })
  cleanups.unshift(() => endpoint.close())
  const response = await fetch(endpoint.endpoint, { method: 'POST', headers: { authorization: 'Bearer operator-token' },
    body: JSON.stringify(call) })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ result: 'stored' })
  expect(received).toEqual(call)
  expect((await fetch(endpoint.endpoint, { method: 'POST', headers: { authorization: 'Bearer other' },
    body: JSON.stringify(call) })).status).toBe(401)
})
