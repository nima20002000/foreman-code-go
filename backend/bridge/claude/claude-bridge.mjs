import { Console } from 'node:console'
import { readFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join } from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

const SDK_VERSION = '0.3.284'
const SDK_METHODS = new Set(['getSessionInfo', 'getSessionMessages', 'forkSession', 'listSubagents', 'getSubagentMessages'])
const QUERY_METHODS = new Set(['interrupt', 'setPermissionMode', 'getContextUsage', 'initializationResult', 'mcpServerStatus', 'setMcpServers'])
const queries = new Map()
const callbacks = new Map()
let sdk
let nextCallback = 0
let shuttingDown = false

// SDK diagnostics must not become protocol frames.
globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr })

function send(frame) {
  const line = `${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`
  return new Promise((resolve, reject) => {
    process.stdout.write(line, error => error ? reject(error) : resolve())
  })
}

function bridgeError(error) {
  return { code: -32000, message: error instanceof Error ? error.message : String(error),
    ...(typeof error?.code === 'string' ? { data: { code: error.code } } : {}) }
}

function promptQueue() {
  const values = []
  let reader
  let ended = false
  return {
    push(value) {
      if (ended) throw new Error('Claude prompt stream is closed')
      if (reader) { const resolve = reader; reader = undefined; resolve({ value, done: false }) }
      else values.push(value)
    },
    end() {
      ended = true
      if (reader) { const resolve = reader; reader = undefined; resolve({ done: true }) }
    },
    cancel() { values.length = 0; this.end() },
    [Symbol.asyncIterator]() { return this },
    next() {
      if (values.length) return Promise.resolve({ value: values.shift(), done: false })
      if (ended) return Promise.resolve({ done: true })
      if (reader) return Promise.reject(new Error('Claude prompt stream already has a reader'))
      return new Promise(resolve => { reader = resolve })
    },
    return() { this.end(); return Promise.resolve({ done: true }) },
  }
}

async function initialize(params) {
  if (sdk) throw new Error('Claude bridge is already initialized')
  const require = createRequire(import.meta.url)
  const selected = params.sdkEntrypoint || require.resolve('@anthropic-ai/claude-agent-sdk')
  if (!isAbsolute(selected) || selected.includes('\0')) throw new Error('Claude SDK requires its qualified absolute entrypoint')
  const entrypoint = await realpath(selected)
  const manifest = JSON.parse(await readFile(join(dirname(entrypoint), 'package.json'), 'utf8'))
  if (manifest.name !== '@anthropic-ai/claude-agent-sdk' || manifest.version !== SDK_VERSION) {
    throw new Error(`Claude bridge requires @anthropic-ai/claude-agent-sdk ${SDK_VERSION}`)
  }
  const loaded = await import(pathToFileURL(entrypoint).href)
  for (const method of ['query', ...SDK_METHODS]) {
    if (typeof loaded[method] !== 'function') throw new Error(`Claude SDK does not satisfy the required ${method} method contract`)
  }
  sdk = loaded
  return { sdkVersion: manifest.version }
}

function remoteCallback(state, name) {
  return async (...args) => {
    const last = args.at(-1)
    const nativeSignal = last && typeof last === 'object' ? last.signal : undefined
    const signal = nativeSignal ? AbortSignal.any([state.controller.signal, nativeSignal]) : state.controller.signal
    signal.throwIfAborted()
    const id = `b${++nextCallback}`
    const encoded = args.map(value => {
      if (!value || typeof value !== 'object' || !('signal' in value)) return value
      return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'signal'))
    })
    return new Promise((resolve, reject) => {
      const finish = (error, result) => {
        callbacks.delete(id)
        signal.removeEventListener('abort', abort)
        if (error) reject(error)
        else resolve(result)
      }
      const abort = () => {
        finish(signal.reason ?? new Error('Claude callback aborted'))
        void send({ method: 'callback.cancel', params: { callbackId: id } }).catch(fatal)
      }
      callbacks.set(id, { finish })
      signal.addEventListener('abort', abort, { once: true })
      void send({ id, method: 'callback', params: { queryId: state.id, name, args: encoded } })
        .catch(error => finish(error))
    })
  }
}

function reviveCallbacks(value, state, names) {
  if (Array.isArray(value)) return value.map(entry => reviveCallbacks(entry, state, names))
  if (!value || typeof value !== 'object') return value
  if (Object.keys(value).length === 1 && typeof value.__foremanBridgeCallback === 'string') {
    const name = value.__foremanBridgeCallback
    if (!names.has(name)) throw new Error(`Claude callback ${name} is not registered`)
    return remoteCallback(state, name)
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, reviveCallbacks(entry, state, names)]))
}

function closeQuery(state) {
  if (state.closed) return
  state.closed = true
  state.prompt.cancel()
  state.controller.abort(new Error('Claude query closed'))
  state.query?.close()
}

async function pump(state) {
  let error
  try {
    for await (const event of state.query) {
      await send({ method: 'query.event', params: { queryId: state.id, event } })
    }
  } catch (failure) { error = bridgeError(failure) }
  finally {
    queries.delete(state.id)
    try { closeQuery(state) } catch (failure) { error ??= bridgeError(failure) }
    await send({ method: 'query.end', params: { queryId: state.id, ...(error ? { error } : {}) } })
  }
}

async function openQuery(params) {
  if (!sdk) throw new Error('Claude bridge has not been initialized')
  if (shuttingDown) throw new Error('Claude bridge is closed')
  if (typeof params.queryId !== 'string' || !params.queryId || queries.has(params.queryId)) throw new Error('Claude query identity is invalid or already open')
  if (!params.options || typeof params.options !== 'object' || Array.isArray(params.options)) throw new Error('Claude query options must be an object')
  for (const server of Object.values(params.options.mcpServers ?? {})) {
    if (server?.type === 'sdk') throw new Error('In-process SDK MCP servers cannot cross the bridge; use the Go HTTP MCP endpoint')
  }
  const state = { id: params.queryId, prompt: promptQueue(), controller: new AbortController(), query: undefined, closed: false }
  queries.set(state.id, state)
  try {
    const options = reviveCallbacks(params.options, state, new Set(params.callbacks ?? []))
    state.query = await sdk.query({ prompt: state.prompt, options: { ...options, abortController: state.controller } })
    if (!state.query || typeof state.query[Symbol.asyncIterator] !== 'function'
      || typeof state.query.close !== 'function' || typeof state.query.interrupt !== 'function') {
      throw new Error('Claude SDK query does not satisfy the streaming query contract')
    }
    if (state.closed) state.query.close()
    void pump(state).catch(fatal)
    return { queryId: state.id }
  } catch (error) {
    queries.delete(state.id)
    closeQuery(state)
    throw error
  }
}

async function dispatch(method, params) {
  if (method === 'initialize') return initialize(params)
  if (method === 'query') return openQuery(params)
  if (SDK_METHODS.has(method)) {
    if (!sdk) throw new Error('Claude bridge has not been initialized')
    return sdk[method](...(params.args ?? []))
  }
  if (method === 'query.close') {
    const state = queries.get(params.queryId)
    if (state) closeQuery(state)
    return null
  }
  const state = queries.get(params.queryId)
  if (!state) throw new Error('Claude query is not open')
  if (method === 'query.input') { state.prompt.push(params.message); return null }
  if (method === 'query.endInput') { state.prompt.end(); return null }
  if (!method.startsWith('query.') || !QUERY_METHODS.has(method.slice(6))) throw new Error(`Unsupported Claude bridge method: ${method}`)
  if (method === 'query.setPermissionMode' && !['default', 'plan'].includes(params.args?.[0])) {
    throw new Error('Claude session permission mode must be default or plan')
  }
  const control = state.query?.[method.slice(6)]
  if (typeof control !== 'function') throw new Error(`Claude SDK query does not support ${method.slice(6)}`)
  return control.apply(state.query, params.args ?? [])
}

async function handle(line) {
  const frame = JSON.parse(line)
  if (frame.jsonrpc !== '2.0') throw new Error('Invalid Claude bridge protocol envelope')
  if (!frame.method) {
    const callback = callbacks.get(frame.id)
    if (callback) callback.finish(frame.error ? new Error(frame.error.message) : undefined, frame.result)
    return
  }
  try {
    const result = await dispatch(frame.method, frame.params ?? {})
    if (frame.id !== undefined) await send({ id: frame.id, result: result ?? null })
  } catch (error) {
    if (frame.id !== undefined) await send({ id: frame.id, error: bridgeError(error) })
    else process.stderr.write(`Claude bridge notification failed: ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  for (const state of queries.values()) closeQuery(state)
  for (const callback of callbacks.values()) callback.finish(new Error('Claude bridge closed'))
}

function fatal(error) {
  process.stderr.write(`Claude bridge transport failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
  shutdown()
  process.stdin.destroy()
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
for await (const line of input) {
  if (line.trim()) void handle(line).catch(fatal)
}
shutdown()
