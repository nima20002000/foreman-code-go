import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import scriptedMcp from '../../fixtures/harnesses/scripted-mcp.cjs'
import scriptedTurns from '../../fixtures/harnesses/scripted-turns.cjs'

const require = createRequire(new URL('../../package.json', import.meta.url))
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const cleanups = []

async function nativeMcpOptions() {
  const root = await mkdtemp(join(tmpdir(), 'conformance-native-mcp-failure-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const server = createServer((_request, response) => response.writeHead(500).end())
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('The owned MCP failure fixture needs its random port.')
  const apiOrigin = `http://127.0.0.1:${address.port}`
  const tokenName = 'CONFORMANCE_MCP_FAILURE_TOKEN'
  vi.stubEnv(tokenName, randomBytes(32).toString('hex'))
  const scope = { apiOrigin, appMcpServerNames: ['graphql'], appMcpTokenNames: [tokenName], mcpModules: {
    client: require.resolve('@modelcontextprotocol/sdk/client/index.js'),
    streamableHttp: require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js'),
  } }
  await writeFile(join(root, 'fixture-scope.json'), JSON.stringify(scope), { flag: 'wx', mode: 0o600 })
  await writeFile(join(root, 'mcp.json'), JSON.stringify({ name: 'graphql', type: 'streamable_http',
    url: `${apiOrigin}/mcp`, bearer_token_env_var: tokenName }), { flag: 'wx', mode: 0o600 })
  return { root, overrides: {}, operation: { cancelled: false, controller: new AbortController() },
    nextRequestId: () => randomUUID(), recordItem: vi.fn() }
}

describe('scripted native MCP cleanup failures', () => {
  afterEach(async () => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    const failures = []
    for (const cleanup of cleanups.splice(0).reverse()) {
      try { await cleanup() } catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, 'Owned MCP failure fixture cleanup failed.')
  })

  it('preserves failed SDK setup and its failed cleanup exactly once', async () => {
    const options = await nativeMcpOptions()
    const primary = new Error('Owned MCP initialization failed.')
    const cleanup = new Error('Owned MCP setup cleanup failed.')
    vi.spyOn(Client.prototype, 'connect').mockRejectedValue(primary)
    const close = vi.spyOn(Client.prototype, 'close').mockRejectedValue(cleanup)
    const turn = scriptedMcp.createMcpTurn(options)
    const failure = await turn.call('read', {}).catch(error => error)
    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure.message).toBe('Native MCP setup and transport cleanup failed.')
    expect(failure.errors).toHaveLength(2)
    expect(failure.errors[0]).toBe(primary)
    expect(failure.errors[1]).toBe(cleanup)
    expect(failure.cause).toBe(cleanup)
    await expect(turn.close()).resolves.toBeUndefined()
    expect(close).toHaveBeenCalledTimes(1)
    expect(options.recordItem).not.toHaveBeenCalled()
  })

  it('preserves a scripted turn failure and the caught MCP close failure', async () => {
    const options = await nativeMcpOptions()
    const primary = new Error('Owned scripted turn failed after its MCP read.')
    const cleanup = new Error('Owned scripted turn cleanup failed.')
    vi.spyOn(Client.prototype, 'connect').mockResolvedValue(undefined)
    vi.spyOn(Client.prototype, 'listTools').mockResolvedValue({
      tools: [{ name: 'read', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }],
    })
    const call = vi.spyOn(Client.prototype, 'callTool').mockResolvedValue({
      content: [{ type: 'text', text: '{"owned":true}' }], structuredContent: { owned: true },
    })
    const close = vi.spyOn(Client.prototype, 'close').mockRejectedValue(cleanup)
    const failure = await scriptedTurns.runWithMcp(options, async read => {
      expect(await read('read', {})).toEqual({ owned: true })
      throw primary
    }).catch(error => error)
    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure.message).toBe('Native scripted turn and MCP transport cleanup failed.')
    expect(failure.errors).toHaveLength(2)
    expect(failure.errors[0]).toBe(primary)
    expect(failure.errors[1]).toBe(cleanup)
    expect(failure.cause).toBe(cleanup)
    expect(call).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
    expect(options.recordItem).toHaveBeenCalledTimes(2)
  })
})
