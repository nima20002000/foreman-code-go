import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'

import { describe, it } from 'vitest'

import { loadConfig } from '../src/config.js'
import { createAppMcpRuntime, localAppMcpEndpoint } from '../src/modules/app-runtime/composition.js'
import { McpDetectionService, WorkerLaunchCredentialService } from '../src/modules/harnesses/mcpDetection.js'
import { registerMcpDetectionRoute } from '../src/routes/mcpDetection.js'

function route(service: McpDetectionService) {
  let handler!: (request: unknown, reply: unknown) => Promise<unknown>
  registerMcpDetectionRoute({ get: (_path: string, action: typeof handler) => { handler = action } } as never, {
    query: async () => ({ rows: [{ execution_location: { runnerId: 'runner-local', rootPath: '/workspace' } }] }),
  } as never, service)
  const request = {
    params: { workspaceId: 'workspace-1', harness: 'codex' },
    raw: Object.assign(new EventEmitter(), { aborted: false }),
    operatorPrincipal: {
      id: 'operator-1', name: 'Operator', audience: 'operator', expiresAt: new Date(Date.now() + 60_000).toISOString(), revokedAt: null,
      grants: [{ actions: ['harnesses:read', 'workspace_locations:read'], scope: { workspaceIds: ['workspace-1'] } }],
    },
  }
  const reply = { raw: Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false }) }
  return { handler, request, reply }
}

describe('PR #11 production composition and HTTP detection', () => {
  it('provides the same credential and detection services consumed by production startup', async () => {
    const config = loadConfig({ DATABASE_URL: 'postgresql://fixture:fixture@localhost/fixture' })
    const pool = {} as never
    const access = {} as never
    const runtime = createAppMcpRuntime({ pool, access, commands: {} as never, interactions: {} as never, config, runnerId: 'runner-local' })
    assert(runtime.executionCredentials instanceof WorkerLaunchCredentialService)
    assert(runtime.mcpDetection.service instanceof McpDetectionService)
    assert.equal(runtime.mcpDetection.pool, pool)
    assert.equal(runtime.appMcp.access, access)
    const bootstrap = await readFile(new URL('../src/production.ts', import.meta.url), 'utf8')
    assert(bootstrap.includes('const launchCredentials: ExecutionCredentialProvider'))
    assert(bootstrap.includes('launchCredentials, approvals, repository'))
    assert(bootstrap.includes('mcpDetection: { pool: database.pool, service: detection }'))
  })

  it('normalizes wildcard listen addresses to usable local endpoints', () => {
    assert.equal(localAppMcpEndpoint('0.0.0.0', 3000), 'http://127.0.0.1:3000/mcp/tools')
    assert.equal(localAppMcpEndpoint('::', 3000), 'http://[::1]:3000/mcp/tools')
  })

  it('accepts workspace-scoped detection authority and denies another workspace', async () => {
    let calls = 0
    const service = new McpDetectionService({ inspect: async (input) => {
      calls += 1
      return { ...input, providerVersion: '0.154.0', inspectedAt: new Date().toISOString() }
    } }, 'http://127.0.0.1:3000/mcp/tools')
    const f = route(service)
    await f.handler(f.request, f.reply)
    assert.equal(calls, 1)
    f.request.params.workspaceId = 'workspace-other'
    await assert.rejects(f.handler(f.request, f.reply))
    assert.equal(calls, 1)
  })

  it('cancels request-owned native inspection when the HTTP client disconnects', async () => {
    let inspected: AbortSignal | undefined
    let ready!: () => void
    const started = new Promise<void>((resolve) => { ready = resolve })
    const service = new McpDetectionService({ inspect: async (input) => {
      inspected = input.signal
      ready()
      return new Promise((_resolve, reject) => input.signal!.addEventListener('abort', () => reject(new Error('abandoned')), { once: true }))
    } }, 'http://127.0.0.1:3000/mcp/tools')
    const f = route(service)
    const response = f.handler(f.request, f.reply)
    await started
    f.reply.raw.emit('close')
    await response
    assert.equal(inspected?.aborted, true)
    assert.equal(f.request.raw.listenerCount('aborted'), 0)
    assert.equal(f.reply.raw.listenerCount('close'), 0)
  })
})
