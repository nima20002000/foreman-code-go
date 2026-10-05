import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUnboundWorkerMcpEndpoint, createWorkerMcpEndpoint } from './workerMcpEndpoint.js'

const roots: string[] = []
const endpoints: Awaited<ReturnType<typeof createWorkerMcpEndpoint>>[] = []
afterEach(async () => { await Promise.all(endpoints.splice(0).map(endpoint => endpoint.close())); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'worker-private-mcp-')); roots.push(root)
  const token = 'actual-test-scoped-worker-token', expiresAt = new Date(Date.now() + 60_000).toISOString()
  const request = vi.fn(async () => ({ statusCode: 200, contentType: 'application/json' as const, body: '{"result":"Main grant checked"}' }))
  const endpoint = await createWorkerMcpEndpoint({ launcher: join(root, 'graphql-mcp.mjs'), signal: new AbortController().signal,
    relay: { environment: { agentId: 'admitted-agent', variables: { GRAPHQL_MCP_TOKEN: token } }, expiresAt, request } })
  endpoints.push(endpoint)
  return { endpoint, token, expiresAt, request, route: join(root, 'routes', `${createHash('sha256').update(token).digest('hex')}.json`) }
}
describe('actual worker-private HTTP relay with Main authorization double, no paired/native proof', () => {
  it('keeps inspection unauthorized and the native URL stable when the actual Main lease arrives', async () => {
    const root = await mkdtemp(join(tmpdir(), 'worker-unbound-mcp-'))
    roots.push(root)
    const endpoint = await createUnboundWorkerMcpEndpoint({ launcher: join(root, 'foreman-code-mcp.mjs'),
      signal: new AbortController().signal })
    endpoints.push(endpoint)
    const url = endpoint.endpoint
    const request = vi.fn(async () => ({ statusCode: 200, contentType: 'application/json' as const,
      body: '{"result":"authorized Main response"}' }))
    const call = (token: string) => fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}' })
    expect((await call('not-issued')).status).toBe(401)
    expect(request).not.toHaveBeenCalled()
    const lease = (token: string) => ({ environment: { agentId: 'admitted-operator',
      variables: { FOREMAN_CODE_MCP_TOKEN: token } }, expiresAt: new Date(Date.now() + 60000).toISOString(), request })
    await endpoint.bindRelay(lease('first-scoped-lease'))
    expect(endpoint.endpoint).toBe(url)
    expect((await call('first-scoped-lease')).status).toBe(200)
    await endpoint.bindRelay(lease('second-scoped-lease'))
    expect(endpoint.endpoint).toBe(url)
    expect((await call('first-scoped-lease')).status).toBe(401)
    expect((await call('second-scoped-lease')).status).toBe(200)
    expect(request).toHaveBeenCalledTimes(2)
    await endpoint.close()
  })
  it('forwards only the exact scoped bearer and retains real authorized expiry in the existing route', async () => {
    const f = await setup()
    const route = JSON.parse(await readFile(f.route, 'utf8'))
    expect(route).toMatchObject({ endpoint: f.endpoint.endpoint, expiresAt: f.expiresAt })
    expect(JSON.stringify(route)).not.toContain(f.token)
    const result = await fetch(f.endpoint.endpoint, { method: 'POST', headers: { authorization: `Bearer ${f.token}`, 'mcp-protocol-version': '2026-07-28' }, body: '{"method":"tools/list"}' })
    expect(result.status).toBe(200)
    expect(await result.json()).toEqual({ result: 'Main grant checked' })
    expect(f.request).toHaveBeenCalledWith({ method: 'tools/list' }, '2026-07-28', expect.any(AbortSignal))
    await f.endpoint.close(); await f.endpoint.close()
    await expect(readFile(f.route)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('denies another bearer before calling Main and rejects malformed bodies', async () => {
    const f = await setup()
    const denied = await fetch(f.endpoint.endpoint, { method: 'POST', headers: { authorization: 'Bearer another-agent' }, body: '{}' })
    expect(denied.status).toBe(401)
    const malformed = await fetch(f.endpoint.endpoint, { method: 'POST', headers: { authorization: `Bearer ${f.token}` }, body: '{' })
    expect(malformed.status).toBe(400)
    expect(f.request).not.toHaveBeenCalled()
  })
})
