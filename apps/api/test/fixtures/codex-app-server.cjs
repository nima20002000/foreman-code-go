/* global require, __dirname, console, process, setInterval, setTimeout */
/* eslint @typescript-eslint/no-require-imports: "off" -- Standalone executable fixture copied without compilation. */
// Deterministic provider fault fixture. It never invokes a model or real tools.
const fs = require('node:fs')
const path = require('node:path')
const readline = require('node:readline')
const root = __dirname
const read = (name, fallback) => {
  try { return JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')) } catch { return fallback }
}
const save = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value))
const flag = (name) => fs.existsSync(path.join(root, name))
const log = (value) => fs.appendFileSync(path.join(root, 'calls.jsonl'), JSON.stringify(value) + '\n')
const args = process.argv.slice(2)
const processDisabledMcp = new Set(args.flatMap((argument, index) => {
  if (argument !== '-c') return []
  const matched = /^mcp_servers\.([A-Za-z0-9_-]+)\.enabled=false$/.exec(args[index + 1] || '')
  return matched ? [matched[1]] : []
}))
log({ cli: args })
if (args[0] === '--version') { console.log(read('version.json', 'codex-cli 0.154.0')); process.exit(0) }
if (flag('diagnostic-barrier') && (args[0] === 'login' || args[1] === 'generate-json-schema')) {
  const wait = new Int32Array(new SharedArrayBuffer(4))
  while (!flag('release-diagnostics')) Atomics.wait(wait, 0, 0, 10)
  log({ diagnosticCompleted: args })
}
if (args[0] === 'login') {
  if (flag('logged-out')) { console.error('Not logged in'); process.exit(1) }
  console.log('Logged in using ChatGPT'); process.exit(0)
}
if (args[0] === 'debug') {
  console.log(JSON.stringify(read('models.json', {
    models: [{ slug: 'test-model', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }], additional_speed_tiers: ['fast'] }],
  }))); process.exit(0)
}
if (args[0] === 'mcp') {
  if (flag('no-mcp')) {
    if (args[1] === 'list') { console.log('[]'); process.exit(0) }
    console.error(`Error: No MCP server named '${args[2]}' found.`)
    process.exit(1)
  }
  if (args[1] === 'list') {
    console.log(JSON.stringify([{ name: read('mcp.json', { name: 'graphql' }).name || 'graphql' }]))
    process.exit(0)
  }
  const entryName = read('mcp.json', { name: 'graphql' }).name || 'graphql'
  if (args[1] === 'get' && args[2] !== entryName) {
    console.error(`Error: No MCP server named '${args[2]}' found.`)
    process.exit(1)
  }
  console.log(JSON.stringify(read('mcp.json', {
    name: args[2], enabled: true, required: true,
    transport: { type: 'streamable_http', url: 'http://127.0.0.1:3000/mcp/app', bearer_token_env_var: 'GRAPHQL_MCP_TOKEN' },
    enabled_tools: ['context_get'], disabled_tools: ['interaction_respond'],
  }))); process.exit(0)
}
if (args[0] !== 'app-server') process.exit(2)
if (args[1] === 'generate-json-schema') {
  const directory = args[args.indexOf('--out') + 1]
  fs.mkdirSync(directory, { recursive: true })
  // Deliberately NOT the qualified manifest; qualification tests must fail closed.
  save(path.relative(root, path.join(directory, 'codex_app_server_protocol.schemas.json')), { definitions: {} })
  process.exit(0)
}
const agent = process.env.TEST_AGENT_ID || 'agent-a'
let current
let nextTurn = 0
let created = 0
let expectedResponses = 0
const outstanding = new Map()
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n')
const result = (id, value) => send({ id, result: value })
const fail = (id) => send({ id, error: { code: -32000, message: 'fixture rejection' } })
const store = () => save(`state-${current.id}.json`, current)
const userMessage = (id, clientId, content = []) => ({ type: 'userMessage', id, clientId: clientId ?? null, content })
const agentMessage = (id, text) => ({
  type: 'agentMessage', id, text, phase: 'final_answer', memoryCitation: null, delivery: null, questions: null,
})
const turn = (id, status = 'inProgress', correlation = null, content = []) => ({
  id, status, itemsView: 'full', error: null, startedAt: 1, completedAt: status === 'inProgress' ? null : 2, durationMs: null,
  items: [userMessage(`native-user-${id}-1`, correlation, content)],
})
const thread = (id, params, original) => ({
  id, sessionId: id, forkedFromId: original?.id || null, parentThreadId: null,
  preview: '', ephemeral: !!params.ephemeral, section: null, sectionEnteredAt: null, projectId: null,
  historyMode: 'legacy', modelProvider: 'openai', model: params.model || 'test-model',
  reasoningEffort: params.config?.model_reasoning_effort || 'medium', createdAt: 1, updatedAt: 1,
  recencyAt: null, status: { type: 'idle' }, path: null, cwd: params.cwd || process.cwd(),
  cliVersion: '0.154.0', originator: null, source: 'appServer', threadSource: null,
  agentNickname: null, agentRole: null, gitInfo: null, name: null,
  turns: original ? JSON.parse(JSON.stringify(original.turns)) : [], settings: settings(params),
})
const settings = (params) => {
  const config = params.config || {}
  const workspace = config.sandbox_workspace_write || {}
  return {
    model: params.model || 'test-model', modelProvider: 'openai', serviceTier: flag('native-priority-tier') && params.serviceTier === 'fast' ? 'priority' : params.serviceTier === 'fast' ? 'fast' : null,
    cwd: params.cwd || process.cwd(), reasoningEffort: config.model_reasoning_effort || 'medium',
    approvalPolicy: params.approvalPolicy || 'on-request', approvalsReviewer: params.approvalsReviewer || 'user', instructionSources: [],
    sandbox: params.sandbox === 'danger-full-access' ? { type: 'dangerFullAccess' }
      : params.sandbox === 'workspace-write' ? {
        type: 'workspaceWrite', writableRoots: workspace.writable_roots || [], networkAccess: workspace.network_access || false,
        excludeTmpdirEnvVar: workspace.exclude_tmpdir_env_var || false, excludeSlashTmp: workspace.exclude_slash_tmp || false,
      } : { type: 'readOnly', networkAccess: false },
  }
}
const replyThread = (id, params) => {
  if (!flag('ignore-resume-settings') || args[0] !== 'app-server') current.settings = settings(params)
  store()
  result(id, { ...current.settings, thread: params.excludeTurns ? { ...current, turns: [] } : current })
}
const complete = (nativeTurn, status = 'completed', answer = `answer-${agent}`) => {
  nativeTurn.status = status
  nativeTurn.completedAt = 2
  nativeTurn.items.push(agentMessage(`answer-${nativeTurn.id}`, answer))
  store()
  const item = nativeTurn.items[nativeTurn.items.length - 1]
  send({ method: 'item/completed', params: { threadId: current.id, turnId: nativeTurn.id, item, completedAtMs: 2 } })
  send({ method: 'item/completed', params: { threadId: current.id, turnId: nativeTurn.id, item, completedAtMs: 2 } })
  send({ method: 'turn/completed', params: { threadId: current.id, turn: nativeTurn } })
}
const approval = (nativeTurn, id) => {
  outstanding.set(id, nativeTurn)
  send({ id, method: 'item/commandExecution/requestApproval', params: {
    threadId: current.id, turnId: nativeTurn.id, itemId: `command-${id}`, command: 'printf harmless', cwd: process.cwd(),
    startedAtMs: 1,
    availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
  } })
}
const expectedEnvironment = read('expected-environment.json', {})
const environmentMatches = Object.fromEntries(Object.entries(expectedEnvironment).map(([key, expected]) => [
  key, expected === null ? !Object.hasOwn(process.env, key) : process.env[key] === expected,
]))
log({ pid: process.pid, agent, environmentMatches })
process.on('exit', () => { log({ exited: process.pid }) })
process.on('SIGTERM', () => { if (!flag('ignore-term')) process.exit(0) })
const inbox = path.join(root, `inbox-${agent}.jsonl`)
let offset = fs.existsSync(inbox) ? fs.readFileSync(inbox, 'utf8').length : 0
setInterval(() => {
  if (!fs.existsSync(inbox)) return
  const contents = fs.readFileSync(inbox, 'utf8')
  const batch = contents.slice(offset); offset = contents.length
  for (const line of batch.split('\n').filter(Boolean)) {
    const message = JSON.parse(line)
    if (message.id !== undefined && message.method) outstanding.set(message.id, current.turns[current.turns.length - 1])
    if (message.method === 'turn/completed' && current) {
      const index = current.turns.findIndex((value) => value.id === message.params.turn.id)
      if (index >= 0) { current.turns[index] = message.params.turn; store() }
    }
    send(message)
  }
}, 10)
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  const message = JSON.parse(line)
  log({ wire: message })
  const params = message.params || {}
  if (message.method === 'initialize') result(message.id, { userAgent: 'codex-cli 0.154.0', platformFamily: 'unix', platformOs: 'linux', codexHome: root })
  else if (message.method === 'initialized') { /* Initialization has no response. */ }
  else if (message.method === 'thread/start') {
    if (flag('fail-start') || flag('required-mcp-failure')) { fail(message.id); return }
    if (flag('late-reject-thread-start')) { setTimeout(() => fail(message.id), 800); return }
    current = thread(`thread-${agent}-${process.pid}-${++created}`, params)
    nextTurn = 0
    store()
    if (flag('late-thread-start')) setTimeout(() => replyThread(message.id, params), 800)
    else replyThread(message.id, params)
  } else if (message.method === 'thread/fork') {
    const original = read(`state-${params.threadId}.json`, null)
    if (!original) { fail(message.id); return }
    current = thread(`thread-${agent}-${process.pid}-${++created}`, params, original)
    nextTurn = current.turns.length
    store()
    if (flag('hold-thread-fork-ack')) return
    if (flag('late-thread-fork')) setTimeout(() => replyThread(message.id, params), 800)
    else replyThread(message.id, params)
  } else if (message.method === 'thread/resume') {
    if (flag('fail-resume')) { fail(message.id); return }
    current = read(`state-${params.threadId}.json`, thread('not-the-requested-thread', params))
    nextTurn = current.turns.length
    if (flag('resume-delay')) setTimeout(() => replyThread(message.id, params), 250)
    else replyThread(message.id, params)
  } else if (message.method === 'thread/read') {
    const persisted = read(`state-${params.threadId}.json`, current)
    const reply = () => result(message.id, { thread: params.includeTurns ? persisted : { ...persisted, turns: [] } })
    if (flag('read-delay')) setTimeout(reply, 250)
    else reply()
  }
  else if (message.method === 'thread/turns/list') {
    const persisted = read(`state-${params.threadId}.json`, current)
    result(message.id, { data: [...persisted.turns].reverse(), nextCursor: null, prevCursor: null })
  }
  else if (message.method === 'turn/start') {
    const prompt = params.input[0].text
    if (prompt === 'reject') { fail(message.id); return }
    const nativeTurn = turn(`turn-${++nextTurn}`, 'inProgress', params.clientUserMessageId, params.input)
    current.turns.push(nativeTurn); store()
    if (prompt === 'lost-start') {
      nativeTurn.status = 'completed'; nativeTurn.completedAt = 2
      nativeTurn.items.push(agentMessage('recovered', 'recovered-answer')); store()
      process.exit(17)
    }
    const started = () => {
      if (!flag('hold-turn-start-ack')) result(message.id, { turn: nativeTurn })
      if (prompt === 'approval' || prompt === 'multi') {
        expectedResponses = prompt === 'multi' ? 2 : 1
        approval(nativeTurn, 900 + nextTurn)
        if (prompt === 'multi') { approval(nativeTurn, 900 + nextTurn); approval(nativeTurn, 1900 + nextTurn) }
      } else if (prompt === 'crash-completed') {
        nativeTurn.status = 'completed'; nativeTurn.completedAt = 2
        nativeTurn.items.push(agentMessage('recovered', 'recovered-answer')); store()
        setTimeout(() => process.exit(17), 15)
      } else if (['wait', 'slow-start', 'late-start'].includes(prompt)) { /* The fixture intentionally leaves the turn active. */ }
      else complete(nativeTurn)
    }
    if (prompt === 'slow-start') setTimeout(started, 250)
    else if (prompt === 'late-start') setTimeout(started, 800)
    else started()
  } else if (message.method === 'turn/steer') {
    const nativeTurn = current.turns.find((entry) => entry.id === params.expectedTurnId && entry.status === 'inProgress')
    if (params.threadId !== current.id || !nativeTurn) { fail(message.id); return }
    const itemId = `native-user-${nativeTurn.id}-${nativeTurn.items.length + 1}`
    nativeTurn.items.push(userMessage(itemId, params.clientUserMessageId, params.input))
    store()
    if (params.input[0].text !== 'lost-steer') result(message.id, { turnId: nativeTurn.id })
  } else if (message.method === 'turn/interrupt') {
    if (flag('interrupt-startup-race')) {
      fs.rmSync(path.join(root, 'interrupt-startup-race'))
      send({ id: message.id, error: { code: -32000, message: 'no active turn to interrupt' } })
      return
    }
    const found = current.turns.find((entry) => entry.id === params.turnId)
    result(message.id, {})
    if (found) complete(found, 'interrupted', '')
  } else if (!message.method && message.id !== undefined) {
    const found = outstanding.get(message.id)
    if (found && message.result) {
      outstanding.delete(message.id)
      if (flag('exit-on-response')) process.exit(18)
      if (!flag('no-resolution')) send({ method: 'serverRequest/resolved', params: { threadId: current.id, requestId: message.id } })
      if (expectedResponses > 0 && --expectedResponses === 0 && !flag('no-resolution')) complete(found, 'completed', `approved-${agent}`)
    }
  } else if (message.method === 'config/read') {
    const configured = read('mcp.json', { name: 'graphql', enabled: true })
    const name = configured.name || 'graphql'
    const servers = flag('no-mcp') ? {} : { [name]: { ...configured,
      enabled: processDisabledMcp.has(name) ? false : configured.enabled !== false } }
    result(message.id, { config: { approval_policy: 'on-request', mcp_servers: servers }, origins: {}, layers: [] })
  }
  else if (message.method === 'mcpServerStatus/list') result(message.id, { data: [], nextCursor: null })
  else if (message.method === 'model/list') result(message.id, { data: [{
    id: 'test-model', model: 'test-model', displayName: 'Test model', description: 'Deterministic protocol fixture',
    hidden: false, isDefault: true, defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Low' },
      { reasoningEffort: 'medium', description: 'Medium' }],
  }], nextCursor: null })
  else if (message.method === 'config/mcpServer/reload') result(message.id, {})
  else if (message.method === 'account/login/start') result(message.id, { type: 'chatgptDeviceCode', loginId: 'login-1', verificationUrl: 'https://example.invalid/device', userCode: 'TEST-CODE' })
  else if (message.method === 'account/login/cancel') result(message.id, { status: 'canceled' })
  else if (message.method === 'test/echo') result(message.id, params)
  else if (message.method === 'test/descendant') {
    const child = require('node:child_process').spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: ['ignore', 1, 2] })
    result(message.id, { pid: child.pid })
  }
  else if (message.method === 'test/frame') process.stdout.write('x'.repeat(5 * 1024 * 1024) + '\n')
  else if (message.method === 'test/request') {
    send({ id: 555, method: 'test/native', params: {} }); result(message.id, {})
  } else if (message.method === 'test/epipe') {
    result(message.id, {}); process.stdin.pause(); fs.closeSync(0)
  }
})
