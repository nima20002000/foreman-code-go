#!/usr/bin/env node
/** Native-only FIL-08 smoke for a real, locally authenticated codex-cli 0.157.x.
 * Uses a disposable Markdown fixture and a fixture publish callback, NOT FIL-05
 * HTTP/PostgreSQL or the production adapter. Does not change native configuration.
 * Run: node scripts/smoke-codex-files.mjs [--codex /absolute/codex] [--model model-id]
 *       [--output /new/result.md] [--timeout-ms 180000]
 * The output path must not exist. No npm install or credential issuance occurs.
 */
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, readFile, open, lstat, realpath, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createInterface } from 'node:readline'
import { randomUUID, createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
const exec = promisify(execFile)

function argumentsFrom(argv) {
  const value = { codex: 'codex', model: undefined, output: undefined, timeoutMs: 180_000 }
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i], next = argv[++i]
    if (!next) throw new Error(`A value is required for ${name}`)
    if (name === '--codex') value.codex = next
    else if (name === '--model') value.model = next
    else if (name === '--output') value.output = resolve(next)
    else if (name === '--timeout-ms') value.timeoutMs = Number(next)
    else throw new Error(`Unknown argument: ${name}`)
  }
  if (!Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1000 || value.timeoutMs > 600_000) throw new Error('Invalid timeout')
  return value
}

// Native ChatGPT authentication can use HOME/CODEX_HOME. Application, database,
// worker and Operator credentials are never inherited or copied into the child.
function nativeEnvironment() {
  const env = { NO_COLOR: '1' }
  for (const key of ['HOME', 'USERPROFILE', 'PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'CODEX_HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP']) {
    if (process.env[key]) env[key] = process.env[key]
  }
  return env
}

async function smoke(argv) {
  const options = argumentsFrom(argv), env = nativeEnvironment()
  const { stdout, stderr } = await exec(options.codex, ['--version'], { env, timeout: 10_000, maxBuffer: 4096 })
  const version = (stdout || stderr).trim()
  if (!/^codex-cli 0\.157\.\d+$/.test(version)) throw new Error(`This native-only smoke requires codex-cli 0.157.x; found ${version}`)
  const help = await exec(options.codex, ['app-server', '--help'], { env, timeout: 10_000, maxBuffer: 65_536 })
  const helpText = `${help.stdout}\n${help.stderr}`
  const stdioArguments = helpText.includes('--stdio') ? ['--stdio']
    : helpText.includes('--listen') && helpText.includes('stdio://') ? ['--listen', 'stdio://'] : undefined
  if (!stdioArguments) throw new Error('Could not verify a stdio app-server option from this installation')
  const login = await exec(options.codex, ['login', 'status'], { env, timeout: 10_000, maxBuffer: 16_384 })
  if (!`${login.stdout}\n${login.stderr}`.includes('Logged in using ChatGPT')) throw new Error('Native ChatGPT login is required')

  const directory = await mkdtemp(join(tmpdir(), 'fil08-native-smoke-'))
  const inputPath = join(directory, 'input.md'), workingPath = join(directory, 'working.md')
  const original = Buffer.from('# FIL-08 smoke\n\nReplace this line: BEFORE\n')
  const marker = `FIL08_EDITED_${randomUUID()}`
  const output = options.output ?? resolve(`fil08-smoke-${randomUUID()}.md`)
  let child, reader, closed, exited = false, copyCreated = false, publicationRequested = false
  let threadId, activeTurnId, starting = false
  const staged = [], operations = new Map(), callbacks = new Set()
  let nextId = 0, fatal
  let resolveTerminal, rejectTerminal
  const terminal = new Promise((done, failed) => { resolveTerminal = done; rejectTerminal = failed })
  // Attach rejection handler immediately: a disconnect may precede awaiting terminal.
  void terminal.catch(() => {})
  const fail = (error) => {
    if (fatal) return
    fatal = error instanceof Error ? error : new Error('Native smoke failed')
    rejectTerminal(fatal)
    for (const pending of operations.values()) { clearTimeout(pending.timer); pending.reject(fatal) }
    operations.clear()
  }
  const write = (message) => {
    if (fatal) throw fatal
    child.stdin.write(JSON.stringify(message) + '\n', (error) => { if (error) fail(error) })
  }
  const request = (method, params) => new Promise((done, failed) => {
    const id = ++nextId
    const timer = setTimeout(() => { operations.delete(id); failed(new Error(`${method} timed out; not replayed`)) }, 30_000)
    operations.set(id, { resolve: done, reject: failed, timer })
    try { write({ id, method, params }) } catch (error) { clearTimeout(timer); operations.delete(id); failed(error) }
  })
  const result = (text, success = true) => ({ success, contentItems: [{ type: 'inputText', text }] })
  const handleTool = async (frame) => {
    const p = frame.params
    if (!p || p.threadId !== threadId || p.turnId !== activeTurnId || p.namespace != null
      || !p.arguments || typeof p.arguments !== 'object' || Array.isArray(p.arguments)) {
      write({ id: frame.id, result: result('Wrong native turn or invalid input.', false) }); return
    }
    const a = p.arguments
    if (p.tool === 'files_create_working_copy' && Object.keys(a).length === 0) {
      if (!copyCreated) { await writeFile(workingPath, original, { flag: 'wx', mode: 0o600 }); copyCreated = true }
      write({ id: frame.id, result: result(JSON.stringify({ artifactId: 'smoke-working-copy', path: workingPath })) })
    } else if (p.tool === 'files_publish_result' && copyCreated && Object.keys(a).length === 1 && a.artifactId === 'smoke-working-copy') {
      // Do not snapshot a file while the Codex process can still write it.
      // This fixture ACK is intentionally not a FIL-05 ready-file receipt.
      publicationRequested = true
      write({ id: frame.id, result: result('Fixture publication requested. The runner will verify the completed Markdown after the native process exits.') })
    } else write({ id: frame.id, result: result('Only the registered smoke artifact is supported.', false) })
  }
  const routeTool = (frame) => {
    const task = handleTool(frame).catch(fail)
    callbacks.add(task); void task.finally(() => callbacks.delete(task))
  }
  const stop = async () => {
    if (!child || exited) return
    child.stdin.end()
    const force = setTimeout(() => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM') } catch { /* Already exited. */ }
    }, 1000)
    const kill = setTimeout(() => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL') } catch { /* Already exited. */ }
    }, 3000)
    try { await closed } finally { clearTimeout(force); clearTimeout(kill) }
  }
  let deadline
  try {
    await writeFile(inputPath, original, { mode: 0o400, flag: 'wx' })
    child = spawn(options.codex, ['app-server', ...stdioArguments,
      '-c', 'mcp_servers.graphql-app.enabled=false',
      '-c', 'mcp_servers.graphql-operator.enabled=false'],
    { cwd: directory, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
    child.stderr.resume() // Never print native diagnostics or authentication details.
    closed = new Promise((done) => {
      child.once('error', (error) => { fail(error); done() })
      child.once('close', () => { exited = true; if (!publicationRequested) fail(new Error('Native process ended before publication')); done() })
    })
    deadline = setTimeout(() => { fail(new Error('Smoke timed out; input was not replayed')); void stop() }, options.timeoutMs)
    reader = (async () => {
      for await (const line of createInterface({ input: child.stdout })) {
        if (Buffer.byteLength(line) > 4 * 1024 * 1024) throw new Error('Native frame exceeds smoke limit')
        const frame = JSON.parse(line)
        if (Object.hasOwn(frame, 'id') && frame.method) {
          if (frame.method === 'item/tool/call') {
            if (starting && !activeTurnId) {
              if (staged.length >= 16) throw new Error('Too many pre-ack callbacks')
              staged.push(frame)
            } else routeTool(frame)
          } else {
            // No permission escalation, shell approval, elicitation or other tool fallback.
            write({ id: frame.id, error: { code: -32601, message: 'Unsupported by file smoke' } })
            fail(new Error(`Unexpected native interaction: ${frame.method}`))
          }
        } else if (Object.hasOwn(frame, 'id')) {
          const pending = operations.get(frame.id)
          if (!pending) continue
          operations.delete(frame.id); clearTimeout(pending.timer)
          if (frame.error) pending.reject(new Error('Native request was rejected; not replayed'))
          else pending.resolve(frame.result)
        } else if (frame.method === 'turn/completed') {
          if (frame.params?.threadId !== threadId) continue
          if (activeTurnId && frame.params.turn?.id !== activeTurnId) continue
          if (frame.params.turn?.status !== 'completed') fail(new Error('Native turn did not complete successfully'))
          else resolveTerminal(frame.params.turn.id)
        }
      }
    })().catch(fail)
    await request('initialize', { clientInfo: { name: 'fil08-smoke', version: '0.1.0' }, capabilities: { experimentalApi: true } })
    write({ method: 'initialized' })
    const started = await request('thread/start', {
      cwd: directory, runtimeWorkspaceRoots: [directory], sandbox: 'workspace-write', approvalPolicy: 'never',
      ...(options.model ? { model: options.model } : {}), ephemeral: true,
      config: { 'mcp_servers.graphql-app.enabled': false,
        'mcp_servers.graphql-operator.enabled': false,
        sandbox_workspace_write: { writable_roots: [], network_access: false, exclude_tmpdir_env_var: true, exclude_slash_tmp: true },
        shell_environment_policy: { inherit: 'none', set: { PATH: env.PATH ?? '' } } },
      dynamicTools: [
        { type: 'function', name: 'files_create_working_copy', description: 'Create the registered temporary working.md copy of input.md.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false }, deferLoading: false },
        { type: 'function', name: 'files_publish_result', description: 'Request publication of the edited smoke working copy. Finish editing before calling.',
          inputSchema: { type: 'object', properties: { artifactId: { type: 'string', enum: ['smoke-working-copy'] } },
            required: ['artifactId'], additionalProperties: false }, deferLoading: false },
      ],
    })
    threadId = started.thread?.id
    if (typeof threadId !== 'string' || !threadId) throw new Error('No native thread identity')
    starting = true
    const turn = await request('turn/start', { threadId, clientUserMessageId: randomUUID(), input: [{ type: 'text', text_elements: [],
      text: `Read the attached Markdown at ${JSON.stringify(inputPath)}. Call files_create_working_copy, then edit the returned working copy directly with your native file tools: replace the entire line "Replace this line: BEFORE" with ${JSON.stringify(marker)}. Preserve the heading. Call files_publish_result with the registered artifact ID and finish with one short sentence. Do not modify input.md, launch background writers, access unrelated paths, or request broader permissions.` }] })
    activeTurnId = turn.turn?.id; starting = false
    if (typeof activeTurnId !== 'string' || !activeTurnId) throw new Error('No native turn identity')
    for (const frame of staged.splice(0)) routeTool(frame)
    const completedTurn = await terminal
    if (completedTurn !== activeTurnId || !publicationRequested) throw new Error('No publication in the exact native turn')
    await Promise.all([...callbacks])
    await stop(); await reader
    if (fatal) throw fatal

    // Fixed registration lookup only, after native process exit. Not a caller path.
    const file = await lstat(workingPath)
    if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.size > 64 * 1024
      || await realpath(workingPath) !== workingPath) throw new Error('Invalid working-copy fixture')
    const descriptor = await open(workingPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    let bytes
    try {
      const current = await descriptor.stat()
      if (current.ino !== file.ino || current.dev !== file.dev || current.size !== file.size) throw new Error('Working copy changed')
      const buffer = Buffer.alloc(file.size + 1)
      let count = 0
      while (count < buffer.length) {
        const chunk = await descriptor.read(buffer, count, buffer.length - count, count)
        if (!chunk.bytesRead) break
        count += chunk.bytesRead
      }
      const after = await descriptor.stat()
      if (count !== file.size || after.size !== file.size || after.mtimeMs !== current.mtimeMs
        || after.ctimeMs !== current.ctimeMs) throw new Error('Working copy changed during verification')
      bytes = buffer.subarray(0, count)
    } finally { await descriptor.close() }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (!text.startsWith('# FIL-08 smoke\n') || !text.includes(marker) || text.includes('BEFORE')) throw new Error('Markdown edit did not match the requested result')
    if (!(await readFile(inputPath)).equals(original)) throw new Error('Input fixture was changed instead of its copy')
    await writeFile(output, bytes, { mode: 0o600, flag: 'wx' })
    console.log(JSON.stringify({ status: 'passed', scope: 'native-only fixture; not production FIL-05 integration',
      version, threadId, turnId: activeTurnId, output, byteSize: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') }, null, 2))
  } finally {
    clearTimeout(deadline)
    await stop(); await reader
    for (const pending of operations.values()) clearTimeout(pending.timer)
    // Only the disposable fixture directory is removed; native config/auth untouched.
    await rm(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  smoke(process.argv.slice(2)).catch((error) => {
    console.error(`FIL-08 smoke failed: ${error instanceof Error ? error.message : 'unknown error'}`)
    process.exitCode = 1
  })
}
