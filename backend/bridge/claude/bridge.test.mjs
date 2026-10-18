import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

async function startBridge(t) {
  const root = await mkdtemp(join(tmpdir(), 'foreman-claude-bridge-'))
  const child = spawn(process.execPath, [fileURLToPath(new URL('./claude-bridge.mjs', import.meta.url))], {
    cwd: root, stdio: ['pipe', 'pipe', 'pipe'], env: {
      HOME: root, TMPDIR: root, CLAUDE_CONFIG_DIR: join(root, 'profile'),
      XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'),
      XDG_STATE_HOME: join(root, 'state'), XDG_CACHE_HOME: join(root, 'cache'),
    },
  })
  const frames = []
  const waiters = new Set()
  let failure
  let ended = false
  let stderr = ''
  let sequence = 0
  const wake = () => { for (const resolve of waiters) resolve(); waiters.clear() }
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => {
    try { frames.push(JSON.parse(line)) }
    catch (error) { failure = error; child.stdin.end() }
    wake()
  })
  child.stderr.on('data', chunk => { stderr += chunk.toString() })
  const exited = new Promise((resolve, reject) => {
    child.once('error', error => { failure = error; ended = true; wake(); reject(error) })
    child.once('close', (code, signal) => { ended = true; wake(); resolve({ code, signal, stderr }) })
  })
  const next = async predicate => {
    for (;;) {
      if (failure) throw failure
      const index = frames.findIndex(predicate)
      if (index >= 0) return frames.splice(index, 1)[0]
      if (ended) throw new Error(`Bridge exited before the requested protocol event: ${stderr}`)
      await new Promise(resolve => { waiters.add(resolve) })
    }
  }
  const send = frame => {
    if (ended) throw new Error('Bridge already exited')
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`)
  }
  const call = async (method, params) => {
    const id = `t${++sequence}`
    send({ id, method, params })
    return next(frame => frame.id === id && !frame.method)
  }
  t.after(async () => {
    if (!ended) child.stdin.end()
    await exited
    await rm(root, { recursive: true, force: true })
  })
  const initialized = await call('initialize', { sdkEntrypoint: fileURLToPath(new URL('./test-fixture/sdk.mjs', import.meta.url)) })
  assert.deepEqual(initialized.result, { sdkVersion: '0.3.284' })
  return { root, call, next, send, finish: async () => { child.stdin.end(); return exited } }
}

async function openQuery(bridge, queryId, options = {}, callbacks = []) {
  const response = await bridge.call('query', { queryId, options, callbacks })
  assert.deepEqual(response.result, { queryId })
}

test('tool input signal fields survive while native callback cancellation stays out of JSON', { timeout: 10_000 }, async t => {
  const bridge = await startBridge(t)
  await openQuery(bridge, 'signal-query', {
    fixtureCase: 'tool-signal', canUseTool: { __foremanBridgeCallback: 'policy' },
  }, ['policy'])
  await bridge.call('query.input', { queryId: 'signal-query', message: { type: 'user', message: { role: 'user', content: 'ask' } } })
  const request = await bridge.next(frame => frame.method === 'callback')
  assert.equal(request.params.args[0], 'SignalTool')
  assert.deepEqual(request.params.args[1], { signal: 'SIGTERM', payload: { value: 7 } })
  assert.deepEqual(request.params.args[2], { toolUseID: 'fixture-tool-request', requestId: 'fixture-control-request' })
  const closed = await bridge.call('query.close', { queryId: 'signal-query' })
  assert.equal(closed.error, undefined)
  const canceled = await bridge.next(frame => frame.method === 'callback.cancel')
  assert.equal(canceled.params.callbackId, request.id)
  assert.equal((await bridge.finish()).code, 0)
})

test('shutdown closes other queries and cancels callbacks after an SDK close throws', { timeout: 10_000 }, async t => {
  const bridge = await startBridge(t)
  const traceFile = join(bridge.root, 'closure-trace.txt')
  await writeFile(traceFile, '', { mode: 0o600 })
  await openQuery(bridge, 'first', { fixtureId: 'first', traceFile, throwOnClose: true })
  await openQuery(bridge, 'second', { fixtureId: 'second', traceFile, fixtureCase: 'tool-signal',
    canUseTool: { __foremanBridgeCallback: 'policy' } }, ['policy'])
  await bridge.call('query.input', { queryId: 'second', message: { type: 'user', message: { role: 'user', content: 'ask' } } })
  const request = await bridge.next(frame => frame.method === 'callback')
  const result = await bridge.finish()
  assert.equal(result.code, 1, 'the actual SDK close failure must remain a failure')
  assert.match(result.stderr, /first SDK close failed/)
  assert.deepEqual((await readFile(traceFile, 'utf8')).trim().split('\n'), ['first:closed', 'second:closed'])
  const canceled = await bridge.next(frame => frame.method === 'callback.cancel')
  assert.equal(canceled.params.callbackId, request.id)
})

test('dynamic MCP changes reject in-process SDK servers like initial query options', { timeout: 10_000 }, async t => {
  const bridge = await startBridge(t)
  await openQuery(bridge, 'mcp-query')
  const response = await bridge.call('query.setMcpServers', {
    queryId: 'mcp-query', args: [{ files: { type: 'sdk', name: 'files', tools: [] } }],
  })
  assert.ok(response.error, 'an in-process server cannot be serialized through the bridge')
  assert.match(response.error.message, /In-process SDK MCP servers cannot cross the bridge/)
  assert.equal((await bridge.finish()).code, 0)
})
