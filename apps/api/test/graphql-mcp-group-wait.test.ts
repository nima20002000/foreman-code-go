import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { copyFile, mkdtemp } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, expect, it } from 'vitest'
import { removeFixtureDirectory } from './helpers/testResources.js'
import { registerAppRoute } from '../src/modules/harnesses/appMcpLauncher.js'

const cleanup: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })

type Reply = (call: { waitSeconds: number; index: number }) => { status: number; result?: unknown; delayMs?: number }
const waitResult = (status: 'still-running' | 'settled') => ({ structuredContent: { run: {}, wait: {
  until: 'group-terminal', status, tickets: 2, settledTickets: status === 'settled' ? 2 : 1 } }, content: [] })

/** A fake authenticated MCP endpoint whose ci_get answers follow a script; the bridge is the unit under test. */
async function fakeEndpoint(reply: Reply) {
  const calls: Array<{ waitSeconds: number; name?: string | undefined }> = []
  const server: Server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const message = JSON.parse(body) as { id?: number; method: string; params?: { name: string; arguments: { waitSeconds: number } } }
      if (message.method !== 'tools/call') { response.writeHead(202).end(); return }
      const index = calls.length
      calls.push({ name: message.params?.name, waitSeconds: message.params?.arguments.waitSeconds ?? 0 })
      const next = reply({ waitSeconds: message.params?.arguments.waitSeconds ?? 0, index })
      setTimeout(() => {
        if (next.status !== 200) { response.writeHead(next.status).end(); return }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: next.result }))
      }, next.delayMs ?? 0)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  const { port } = server.address() as { port: number }
  return { endpoint: `http://127.0.0.1:${port}/mcp`, calls }
}

interface BridgeReply {
  id: number
  result: { structuredContent: { wait: { status: string; tickets: number; settledTickets: number } } }
  error: { code: number; message: string; data: { kind: string } }
}

/** Starts the managed stdio bridge the way a harness launches it, with a route to the fake endpoint. */
async function startBridge(endpoint: string) {
  const directory = await mkdtemp(join(tmpdir(), 'graphql-group-wait-'))
  cleanup.push(() => removeFixtureDirectory(directory))
  const launcher = join(directory, 'graphql-mcp.mjs')
  await copyFile(new URL('../../../scripts/graphql-mcp.mjs', import.meta.url), launcher)
  const token = `group-wait-${Math.random().toString(36).slice(2)}`
  await registerAppRoute(token, endpoint, new Date(Date.now() + 120_000).toISOString(), launcher)
  const environment = Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => name !== 'FOREMAN_CODE_MCP_TOKEN'))
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [launcher],
    { env: { ...environment, GRAPHQL_MCP_TOKEN: token }, stdio: 'pipe' })
  cleanup.push(() => { child.kill() })
  const replies = new Map<number, (message: BridgeReply) => void>()
  const lines: Array<{ id?: number }> = []
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line) as BridgeReply & { id?: number }
    lines.push(message)
    if (message.id !== undefined) replies.get(message.id)?.(message)
  })
  return {
    lines,
    request: (id: number, method: string, params: unknown) => new Promise<BridgeReply>(resolve => {
      replies.set(id, resolve)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    }),
    notify: (method: string, params: unknown) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`),
  }
}

const groupWait = (ticketId: string, waitSeconds: number) => ({ name: 'ci_get',
  arguments: { ticketId, waitUntil: 'group-terminal', waitSeconds, logTail: false } })

it('keeps one Agent tool call open across bounded chunks until the group settles', async () => {
  const fake = await fakeEndpoint(({ index }) => ({ status: 200, delayMs: 100,
    result: waitResult(index < 2 ? 'still-running' : 'settled') }))
  const bridge = await startBridge(fake.endpoint)
  const started = Date.now()
  const reply = await bridge.request(7, 'tools/call', groupWait('ticket', 30))
  expect(reply.result.structuredContent.wait.status).toBe('settled')
  expect(Date.now() - started).toBeLessThan(5_000)
  expect(fake.calls).toHaveLength(3)
  expect(fake.calls[1]!.waitSeconds!).toBeLessThan(fake.calls[0]!.waitSeconds!)
  expect(bridge.lines.filter(line => line.id === 7)).toHaveLength(1)
})

it('returns one still-running result when the wait budget elapses', async () => {
  const fake = await fakeEndpoint(() => ({ status: 200, delayMs: 200, result: waitResult('still-running') }))
  const bridge = await startBridge(fake.endpoint)
  const started = Date.now()
  const reply = await bridge.request(8, 'tools/call', groupWait('ticket', 1))
  expect(reply.result.structuredContent.wait).toMatchObject({ status: 'still-running', tickets: 2, settledTickets: 1 })
  expect(Date.now() - started).toBeGreaterThanOrEqual(900)
  expect(Date.now() - started).toBeLessThan(5_000)
  expect(fake.calls.length).toBeGreaterThan(1)
  expect(bridge.lines.filter(line => line.id === 8)).toHaveLength(1)
})

it('continues the same wait after a transient Main outage', async () => {
  const fake = await fakeEndpoint(({ index }) => index === 0
    ? { status: 503 } : { status: 200, result: waitResult('settled') })
  const bridge = await startBridge(fake.endpoint)
  const reply = await bridge.request(9, 'tools/call', groupWait('ticket', 30))
  expect(reply.result.structuredContent.wait.status).toBe('settled')
  expect(fake.calls).toHaveLength(2)
}, 20_000)

it('fails a denied group wait once without polling', async () => {
  const fake = await fakeEndpoint(() => ({ status: 403 }))
  const bridge = await startBridge(fake.endpoint)
  const reply = await bridge.request(10, 'tools/call', groupWait('ticket', 300))
  expect(reply.error.data.kind).toBe('forbidden')
  expect(fake.calls).toHaveLength(1)
})

it('forwards an ordinary ci_get once even when the reply is a still-running wait', async () => {
  const fake = await fakeEndpoint(() => ({ status: 200, result: waitResult('still-running') }))
  const bridge = await startBridge(fake.endpoint)
  const reply = await bridge.request(11, 'tools/call', { name: 'ci_get', arguments: { ticketId: 'ticket' } })
  expect(reply.result.structuredContent.wait.status).toBe('still-running')
  expect(fake.calls).toHaveLength(1)
})

it('returns the last still-running result when Main is unreachable as the budget ends', async () => {
  const fake = await fakeEndpoint(({ index }) => index === 0
    ? { status: 200, result: waitResult('still-running') } : { status: 503 })
  const bridge = await startBridge(fake.endpoint)
  const reply = await bridge.request(12, 'tools/call', groupWait('ticket', 2))
  expect(reply.result.structuredContent.wait).toMatchObject({ status: 'still-running', tickets: 2, settledTickets: 1 })
  expect(fake.calls.length).toBeGreaterThan(1)
}, 20_000)
