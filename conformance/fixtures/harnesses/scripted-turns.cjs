/* eslint @typescript-eslint/no-require-imports: "off" -- Adjacent native fixture extension. */
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { selectTurnScript, runTurnScript, presentThenHoldTerminal } = require('./scripted-plans.cjs')
const { createMcpTurn } = require('./scripted-mcp.cjs')

function readOptional(file, fallback) {
  if (!fs.existsSync(file)) return fallback
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function qualificationRequest(prompt) {
  const match = /^Call files_read with fileId ([\w-]+) and revisionId ([\w-]+) to read the Markdown marker\. Write ("(?:[^"\\]|\\.)*") as Markdown containing that marker and the word QUALIFIED\. Then call files_publish_result with artifactId qualification-result, commandId ([\w-]+), filename qualification-result\.md, mediaType text\/markdown, and scope (\{.*\})\. Do not use shell commands or access other paths\.$/.exec(prompt)
  if (!match) return undefined
  return { fileId: match[1], revisionId: match[2], output: JSON.parse(match[3]),
    commandId: match[4], scope: JSON.parse(match[5]) }
}

function ownedWorkspace(root, owner) {
  const configuration = readOptional(path.join(root, 'fixture-scope.json'), null)
  if (!configuration || !path.isAbsolute(configuration.directory)) throw new Error('Owned fixture scope is unavailable.')
  const directory = fs.realpathSync(configuration.directory)
  const cwd = fs.realpathSync(owner.settings.cwd)
  const relative = path.relative(directory, cwd)
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Native workspace is outside the isolated fixture scope.')
  }
  return cwd
}

function ownedOutput(root, owner, output) {
  const cwd = ownedWorkspace(root, owner)
  if (!['workspaceWrite', 'dangerFullAccess'].includes(owner.settings.sandbox.type)) {
    throw new Error('The native sandbox is read-only; a file publication cannot write.')
  }
  if (typeof output !== 'string' || !path.isAbsolute(output) || path.basename(output) !== 'qualification-result.md'
    || fs.realpathSync(path.dirname(output)) !== cwd) throw new Error('Qualification output is outside its native workspace.')
  if (fs.existsSync(output) && !fs.lstatSync(output).isFile()) throw new Error('Qualification output must be a regular file.')
  return output
}

function jsonToolValue(response) {
  if (!response || response.success !== true || !Array.isArray(response.contentItems)) {
    throw new Error('Native dynamic tool did not succeed.')
  }
  const text = response.contentItems.find(item => item.type === 'inputText' && typeof item.text === 'string')
  if (!text) throw new Error('Native dynamic tool returned no JSON text.')
  return JSON.parse(text.text)
}

function nativeFailure(error) {
  return { message: error.message, codexErrorInfo: error.codexErrorInfo ?? null,
    additionalDetails: null, misalignment: null }
}

async function runWithMcp(options, run) {
  const mcp = createMcpTurn(options)
  let answer
  let failure
  try { answer = await run(mcp.call) }
  catch (error) { failure = error }
  try { await mcp.close() }
  catch (cleanup) {
    if (failure) throw new AggregateError([failure, cleanup], 'Native scripted turn and MCP transport cleanup failed.', { cause: cleanup })
    throw cleanup
  }
  if (failure) throw failure
  return answer
}

function createScriptedTurns({ root, send, complete, loadThread, store }) {
  let sequence = 0
  const pending = new Map()
  const active = new Map()
  const threadFile = id => path.join(root, `script-thread-${createHash('sha256').update(id).digest('hex')}.json`)
  const registerThread = (owner, params, sourceId) => {
    const previous = sourceId ? readOptional(threadFile(sourceId), {}) : {}
    const overrides = Object.fromEntries(Object.entries(params.config || {})
      .filter(([key]) => key === 'mcp_servers' || key.startsWith('mcp_servers.')))
    const metadata = { dynamicTools: params.dynamicTools || previous.dynamicTools || [],
      mcpOverrides: { ...previous.mcpOverrides, ...overrides } }
    fs.writeFileSync(threadFile(owner.id), JSON.stringify(metadata), { mode: 0o600 })
  }
  const nextRequestId = () => `conformance-native-${process.pid}-${++sequence}`
  const recordItem = (threadId, turnId, item, completed) => {
    const owner = loadThread(threadId)
    const turn = owner?.turns.find(value => value.id === turnId)
    if (!turn) throw new Error('Native scripted item has no durable turn.')
    const index = turn.items.findIndex(value => value.id === item.id)
    if (index === -1) turn.items.push(item)
    else turn.items[index] = item
    store(owner)
    const timing = completed ? { completedAtMs: 2 } : { startedAtMs: 1 }
    send({ method: completed ? 'item/completed' : 'item/started', params: { threadId, turnId, item, ...timing } })
  }
  const requestNative = (owner, turn, id, method, params, operation) => {
    if (operation.cancelled) return Promise.reject(new Error('Scripted native turn was interrupted.'))
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Native response timed out: ${method}`))
      }, 25_000)
      pending.set(id, { resolve, reject, timeout, threadId: owner.id, operation })
      send({ id, method, params: { ...params, threadId: owner.id, turnId: turn.id } })
    })
  }
  const requestTool = async (owner, turn, name, argumentsValue, operation) => {
    if (operation.cancelled) throw new Error('Scripted native turn was interrupted.')
    const metadata = readOptional(threadFile(owner.id), {})
    if (!metadata.dynamicTools?.some(tool => tool.name === name)) {
      throw new Error(`Native dynamic tool is not declared: ${name}`)
    }
    const id = nextRequestId()
    const item = { type: 'dynamicToolCall', id, namespace: null, tool: name, arguments: argumentsValue,
      status: 'inProgress', contentItems: null, success: null, durationMs: null }
    recordItem(owner.id, turn.id, item, false)
    const response = await requestNative(owner, turn, id, 'item/tool/call', {
      callId: id, tool: name, arguments: argumentsValue,
    }, operation)
    if (!response || typeof response.success !== 'boolean' || !Array.isArray(response.contentItems)) {
      throw new Error('Native dynamic tool returned an invalid response.')
    }
    recordItem(owner.id, turn.id, { ...item, status: response.success ? 'completed' : 'failed',
      contentItems: response.contentItems, success: response.success, durationMs: 1 }, true)
    return response
  }
  const requestInteraction = async (owner, turn, method, parameters, operation) => {
    const id = nextRequestId()
    const params = { itemId: id, ...parameters }
    if (method === 'item/commandExecution/requestApproval') params.startedAtMs ??= 1
    const response = await requestNative(owner, turn, id, method, params, operation)
    if (method === 'item/tool/requestUserInput') {
      recordItem(owner.id, turn.id, { type: 'functionCallOutput', id: params.itemId,
        name: 'request_user_input', namespace: null, output: JSON.stringify(response) }, true)
    }
    return response
  }
  const qualify = async (owner, turn, request, operation) => {
    const output = ownedOutput(root, owner, request.output)
    const read = jsonToolValue(await requestTool(owner, turn, 'files_read', {
      fileId: request.fileId, revisionId: request.revisionId, offset: 0, length: 65_536,
    }, operation))
    if (read.status !== 'ready' || read.eof !== true || read.revision?.fileId !== request.fileId
      || read.revision?.revisionId !== request.revisionId || typeof read.contentBase64 !== 'string') {
      throw new Error('Native read did not return the requested complete Markdown revision.')
    }
    if (operation.cancelled) throw new Error('Scripted native turn was interrupted.')
    const source = Buffer.from(read.contentBase64, 'base64')
    if (source.length !== read.byteLength) throw new Error('Native read byte count does not match its content.')
    // O_NOFOLLOW rejects an output symlink, including a race after the directory check.
    const descriptor = fs.openSync(output, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600)
    try { fs.writeFileSync(descriptor, `${source.toString('utf8')}\nQUALIFIED\n`) }
    finally { fs.closeSync(descriptor) }
    jsonToolValue(await requestTool(owner, turn, 'files_publish_result', {
      artifactId: 'qualification-result', commandId: request.commandId,
      filename: 'qualification-result.md', mediaType: 'text/markdown', scope: request.scope,
    }, operation))
    return 'The Markdown marker was read and the edited result was published through native file tools.'
  }
  const startTurn = (owner, turn, prompt, input) => {
    const request = qualificationRequest(prompt)
    let plan
    try {
      if (!request) plan = selectTurnScript(root, prompt)
      if (request || plan) ownedWorkspace(root, owner)
    }
    catch (error) {
      complete(owner.id, turn.id, 'failed', '', nativeFailure(error))
      return true
    }
    if (!request && !plan) return false
    const key = `${owner.id}:${turn.id}`
    const operation = { cancelled: false, controller: new AbortController() }
    active.set(key, operation)
    const run = () => {
      if (request) return qualify(owner, turn, request, operation)
      const overrides = readOptional(threadFile(owner.id), {}).mcpOverrides || {}
      return runWithMcp({ root, overrides, operation, nextRequestId,
        recordItem: (item, completed) => recordItem(owner.id, turn.id, item, completed) },
      callMcpTool => runTurnScript({ root, input, plan, operation, jsonToolValue, callMcpTool,
        callTool: (name, argumentsValue) => requestTool(owner, turn, name, argumentsValue, operation),
        requestInteraction: (method, parameters) => requestInteraction(owner, turn, method, parameters, operation) }))
    }
    void run().then(async answer => {
      await presentThenHoldTerminal(root, plan, operation, () => {
        // A genuine native provisional notification precedes final history. No
        // public frame or accepted receipt is synthesized by this fixture.
        send({ method: 'item/agentMessage/delta', params: { threadId: owner.id, turnId: turn.id,
          itemId: `answer-${turn.id}`, delta: answer } })
      })
      const native = loadThread(owner.id)?.turns.find(value => value.id === turn.id)
      if (!operation.cancelled && native?.status === 'inProgress') complete(owner.id, turn.id, 'completed', answer)
    }).catch(error => {
      if (!operation.cancelled) complete(owner.id, turn.id, 'failed', '', nativeFailure(error))
    }).finally(() => active.delete(key))
    return true
  }
  const handleResponse = message => {
    const request = pending.get(message.id)
    if (!request) return false
    pending.delete(message.id)
    clearTimeout(request.timeout)
    send({ method: 'serverRequest/resolved', params: { threadId: request.threadId, requestId: message.id } })
    if (message.error) request.reject(new Error(`Native dynamic tool failed: ${message.error.message}`))
    else request.resolve(message.result)
    return true
  }
  const interrupt = (threadId, turnId) => {
    const operation = active.get(`${threadId}:${turnId}`)
    if (!operation) return
    operation.cancelled = true
    operation.controller.abort(new Error('Scripted native turn was interrupted.'))
    for (const [id, request] of pending) {
      if (request.operation !== operation) continue
      pending.delete(id)
      clearTimeout(request.timeout)
      request.reject(new Error('Scripted native turn was interrupted.'))
    }
  }
  return { registerThread, startTurn, handleResponse, interrupt }
}

module.exports = { createScriptedTurns, runWithMcp }
