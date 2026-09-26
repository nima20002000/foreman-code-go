#!/usr/bin/env node
import { spawn, execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { BASE, HELP, assertOwned, databaseUrl, environment, freePort, options, publicError } from './safety.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const exec = promisify(execFile)
const service = join(root, 'scripts/acceptance/service.mjs')
const abort = new AbortController()
let state, owner, pg, api, web, input, stage = 'arguments', stopping = false, preserve = false
let end
const ended = new Promise((resolve) => { end = resolve })
const safeEnv = environment(process.env)
const toolEnv = Object.fromEntries(Object.entries(safeEnv).filter(([key]) => !key.endsWith('_API_KEY')))
const children = []
function interrupted() { if (abort.signal.aborted) throw new Error('Acceptance interrupted.') }
function finish(code = 0) {
  if (code) process.exitCode = code
  abort.abort(); end()
}
process.once('SIGINT', () => finish())
process.once('SIGTERM', () => finish())

// No command text, error message, output, connection URL or environment dump is
// forwarded to the terminal. stdout is captured only for non-secret identity probes.
async function command(file, args, { cwd = root, capture = false, timeout = 90_000 } = {}) {
  interrupted()
  const result = await exec(file, args, { cwd, env: toolEnv, encoding: 'utf8',
    maxBuffer: 1024 * 1024, timeout, signal: abort.signal, killSignal: 'SIGTERM' })
  return capture ? result.stdout.trim() : undefined
}
function ownedChild(name, file, args, env, ipc = false) {
  interrupted()
  const child = spawn(file, args, { cwd: root, env, detached: true,
    stdio: ipc ? ['ignore', 'ignore', 'ignore', 'ipc'] : 'ignore' })
  let ready, failed, exited
  const record = { name, child, expected: false, closed: false, done: false, pending: new Map() }
  record.ready = new Promise((resolve, reject) => { ready = resolve; failed = reject })
  // A process can fail while a different startup stage is being awaited.
  record.ready.catch(() => undefined)
  record.exited = new Promise((resolve) => { exited = resolve })
  const onExit = (code) => {
    if (record.done) return
    record.done = true; record.code = code
    failed(new Error('Owned process exited before readiness.'))
    for (const request of record.pending.values()) request.reject(new Error('Service exited.'))
    record.pending.clear(); exited()
    if (!record.expected && !stopping) {
      if (name === 'API') preserve = true
      console.error(`ENG07 ${name} exited unexpectedly. No other service will be adopted.`)
      finish(1)
    }
  }
  child.once('error', () => onExit(1))
  child.once('exit', (code) => onExit(code ?? 1))
  if (ipc) child.on('message', (message) => {
    if (message?.type === 'ready') ready()
    if (message?.type === 'closed') record.closed = true
    if (message?.type === 'notice') {
      // A notice is NOT evidence of recovery or native closure. Retain receipts
      // at teardown rather than erase potentially unresolved crash evidence.
      preserve = true
      if (!record.noticeShown) { console.log('ENG07 recovery is unresolved; inspect the Run before continuing.'); record.noticeShown = true }
    }
    if (message?.type === 'failure') {
      const error = Object.assign(new Error('Service operation failed.'), { code: message.code })
      if (message.requestId) record.pending.get(message.requestId)?.reject(error)
      else failed(error)
    }
    if (message?.type === 'result') record.pending.get(message.requestId)?.resolve(message.result)
  })
  children.push(record)
  return record
}
async function bounded(promise, milliseconds, label) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(label), { code: 'ACCEPTANCE_TIMEOUT' })), milliseconds)
  })]) } finally { clearTimeout(timer) }
}
async function request(record, type, content = {}) {
  interrupted()
  const requestId = randomUUID()
  const response = new Promise((resolve, reject) => { record.pending.set(requestId, { resolve, reject }) })
  try {
    record.child.send({ type, requestId, ...content }, (error) => {
      if (error) record.pending.get(requestId)?.reject(new Error('IPC unavailable.'))
    })
    return await bounded(response, type === 'seed' ? 180_000 : 300_000, type)
  } finally { record.pending.delete(requestId) }
}
async function stop(record, signal = 'SIGTERM', milliseconds = 75_000) {
  if (!record || record.done) return
  record.expected = true
  // Exact child handles, never port owners, process-name matches or a PID file.
  record.child.kill(signal)
  await bounded(record.exited, milliseconds, 'owned shutdown')
}
async function shutdown() {
  stopping = true
  input?.close()
  let orderly = true
  for (const record of [web, api]) {
    if (!record) continue
    try {
      await stop(record)
      if (record.code !== 0 || !record.closed) orderly = false
    } catch {
      orderly = false
      record.expected = true; record.child.kill('SIGKILL')
      await bounded(record.exited, 5000, 'owned forced exit').catch(() => undefined)
    }
  }
  try {
    // SIGINT is PostgreSQL's fast shutdown, scoped to our foreground postmaster.
    await stop(pg, 'SIGINT', 20_000)
    if (pg && pg.code !== 0) orderly = false
  } catch {
    orderly = false
    pg.expected = true; pg.child.kill('SIGQUIT')
    await bounded(pg.exited, 5000, 'owned PostgreSQL exit').catch(() => undefined)
  }
  if (!state) return
  if (!orderly || preserve || children.some((record) => !record.done)) {
    process.exitCode = 1
    console.error(`ENG07 retained private task state: ${state}`)
    console.error('Native/cleanup settlement is not proven. Do not delete it or kill processes by name. See the walkthrough.')
    return
  }
  await assertOwned(state, owner)
  await rm(state, { recursive: true })
  console.log('ENG07 owned cluster and task files removed. No external database was contacted.')
}
async function readyHttp(url, accepts, headers = {}) {
  interrupted()
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) })
  if (!response.ok || !accepts(await response.text())) throw new Error('Service readiness failed.')
}
async function main() {
  const opts = options(process.argv.slice(2))
  if (opts.help) { console.log(HELP); return }
  stage = 'prerequisites (Node 22+, non-root Unix, PostgreSQL 17, installed pinned pnpm dependencies)'
  if (!['linux', 'darwin'].includes(process.platform) || !process.getuid || process.getuid() === 0
    || Number(process.versions.node.split('.')[0]) < 22) throw new Error('Unsupported execution environment.')
  if (process.platform !== 'linux' && !opts.smoke) {
    stage = 'native recovery requires Linux at this head (macOS supports --smoke only)'
    throw new Error('Native recovery platform unsupported.')
  }
  if (!opts.smoke && !process.stdin.isTTY) throw new Error('Interactive acceptance needs a terminal; use --smoke for CI.')
  const apiRequire = createRequire(join(root, 'apps/api/package.json'))
  const tsx = apiRequire.resolve('tsx')
  createRequire(join(root, 'apps/web/package.json')).resolve('vite')
  apiRequire.resolve('pg'); apiRequire.resolve('@modelcontextprotocol/client')
  const pgBin = opts.pgBin ?? await command('pg_config', ['--bindir'], { capture: true })
  if (!pgBin.startsWith('/') || /[\r\n\0]/.test(pgBin)) throw new Error('Invalid PostgreSQL binary directory.')
  for (const executable of ['postgres', 'initdb', 'psql', 'pg_isready']) {
    const version = await command(join(pgBin, executable), ['--version'], { capture: true })
    if (!/\(PostgreSQL\) 17(?:\.|\s|$)/.test(version)) throw new Error('PostgreSQL 17 is required.')
  }
  // Do not run native providers in smoke mode: it verifies setup/transport only.
  if (!opts.smoke) {
    stage = 'OpenCode prerequisite (qualified 1.18.31 binary)'
    const version = await command(safeEnv.OPENCODE_BINARY ?? 'opencode', ['--version'], { capture: true })
    if (version !== '1.18.31') throw new Error('OpenCode version does not match the pinned source.')
  }
  stage = 'port reservation check'
  await freePort(opts.apiPort); await freePort(opts.webPort)
  const head = await command('git', ['rev-parse', 'HEAD'], { capture: true })
  if (head !== BASE) console.log('ENG07 checkout differs from the documented base; record its commit separately before accepting results.')
  stage = 'contracts build (run corepack pnpm install beforehand)'
  await command('corepack', ['pnpm', '--filter', '@graphql/contracts', 'build'])
  interrupted()
  process.umask(0o077)
  // Canonical /tmp also handles macOS /private/tmp. No caller-selected path.
  state = await mkdtemp(join(await realpath('/tmp'), 'eng07-'))
  await chmod(state, 0o700)
  owner = randomUUID()
  await writeFile(join(state, 'owner.json'), JSON.stringify({ owner, base: BASE }), { mode: 0o600, flag: 'wx' })
  await assertOwned(state, owner)
  for (const name of ['socket', 'projects', 'runtime', 'empty-env', 'tmp']) await mkdir(join(state, name), { mode: 0o700 })
  const database = `eng07_${randomBytes(8).toString('hex')}`
  stage = 'isolated initdb'
  await command(join(pgBin, 'initdb'), ['-D', join(state, 'pg'), '--username=eng07_owner',
    '--encoding=UTF8', '--no-locale', '--auth-local=trust', '--auth-host=reject'], { cwd: state })
  stage = 'isolated PostgreSQL startup'
  pg = ownedChild('PostgreSQL', join(pgBin, 'postgres'), ['-D', join(state, 'pg'), '-k', join(state, 'socket'),
    '-p', '5432', '-c', 'listen_addresses=', '-c', 'unix_socket_permissions=0700',
    '-c', 'logging_collector=off', '-c', 'log_statement=none', '-c', 'log_min_error_statement=panic',
    '-c', 'log_min_messages=panic', '-c', 'log_connections=off', '-c', 'log_disconnections=off'], toolEnv)
  const connection = ['-h', join(state, 'socket'), '-p', '5432', '-U', 'eng07_owner']
  let live = false
  for (let n = 0; n < 120; n++) {
    interrupted()
    if (pg.done) throw new Error('Task PostgreSQL exited.')
    try { await command(join(pgBin, 'pg_isready'), [...connection, '-d', 'postgres'], { timeout: 2000 }); live = true; break }
    catch { await delay(250) }
  }
  if (!live) throw new Error('Task PostgreSQL never became ready.')
  const sql = (db, statement, capture = false) => command(join(pgBin, 'psql'),
    ['-X', '-w', ...connection, '-d', db, '-v', 'ON_ERROR_STOP=1', '-At', '-c', statement], { cwd: state, capture })
  const directory = await sql('postgres', "select current_setting('data_directory')", true)
  if (await realpath(directory) !== await realpath(join(state, 'pg'))) throw new Error('Task database identity mismatch.')
  stage = 'task database and schema creation'
  // Generated identifier only; there is no existing-server/admin URL argument.
  await sql('postgres', `CREATE DATABASE ${database} OWNER eng07_owner TEMPLATE template0`)
  await sql(database, 'CREATE SCHEMA eng07 AUTHORIZATION eng07_owner; REVOKE CREATE ON SCHEMA public FROM PUBLIC;')
  await sql(database, `ALTER DATABASE ${database} SET search_path TO eng07, public`)
  const apiUrl = `http://127.0.0.1:${opts.apiPort}`, webUrl = `http://127.0.0.1:${opts.webPort}`
  const appEnv = { ...safeEnv, NODE_ENV: 'development', HOST: '127.0.0.1', PORT: String(opts.apiPort),
    DATABASE_URL: databaseUrl(state, database), DATABASE_QUERY_TIMEOUT_MS: '60000',
    LANGGRAPH_CHECKPOINT_SCHEMA: 'eng07_checkpoints', HARNESS_WORKSPACE_ROOT: join(state, 'runtime'),
    GRAPHQL_DEV_BROWSER_ACCESS: '1', GRAPHQL_DEV_BROWSER_ORIGIN: webUrl,
    GRAPHQL_DEV_OPERATOR_PRINCIPAL_ID: `eng07-owner-${owner}`, ENG07_DATABASE: database,
    ENG07_STATE: state, ENG07_OWNER: owner, ENG07_WEB_PORT: String(opts.webPort),
    ...(opts.codexModel ? { ENG07_CODEX_MODEL: opts.codexModel } : {}), TMPDIR: join(state, 'tmp') }
  const startApi = async () => {
    interrupted(); await assertOwned(state, owner); await freePort(opts.apiPort)
    api = ownedChild('API', process.execPath, ['--import', tsx, service, 'api'], appEnv, true)
    await bounded(api.ready, 120_000, 'API startup')
    await readyHttp(`${apiUrl}/health/ready`, () => true)
    await readyHttp(`${apiUrl}/api/auth/session`, (body) => JSON.parse(body).localDev === true, { origin: webUrl })
  }
  stage = 'API migrations and production startup'
  await startApi()
  stage = 'semantics-3 seed and persisted readback'
  const demo = await request(api, 'seed')
  stage = 'web startup'
  const webEnv = { ...toolEnv, NODE_ENV: 'development', ENG07_STATE: state, ENG07_OWNER: owner,
    ENG07_WEB_PORT: String(opts.webPort), VITE_API_URL: apiUrl, TMPDIR: join(state, 'tmp') }
  web = ownedChild('Web', process.execPath, ['--import', tsx, service, 'web'], webEnv, true)
  await bounded(web.ready, 90_000, 'Web startup')
  await readyHttp(webUrl, (body) => /<html(?:\s|>)/i.test(body))
  await readyHttp(`${webUrl}/api/auth/session`, (body) => JSON.parse(body).localDev === true, { origin: webUrl })
  console.log(`ENG07 ready: ${webUrl} (API ${apiUrl}). Dev browser access is loopback-only.`)
  console.log(`Workspace: ${demo.workspaceId}; seven saved workflows, ${demo.agentCount} Agents.`)
  console.log(`Execution folder: ${demo.executionFolder}`)
  if (opts.codexModel) console.log('Codex branch seeded. Check native project-config trust and MCP readiness before Start; no trust or account settings were changed.')
  const probe = async (runId) => {
    stage = 'HTTP/MCP parity'
    const result = await request(api, 'parity', { demo, ...(runId ? { runId } : {}) })
    console.log(`ENG07 parity passed: ${result.comparisons} exact comparisons, ${result.deniedTransports} denied transports, one cross-transport command replay.`)
  }
  if (opts.smoke) { await probe(); return }
  stage = 'interactive acceptance'
  console.log('Open ENG07 Acceptance in the Board. No Run starts automatically.')
  console.log('Commands: restart-api | crash-api | parity [RUN_ID] | quit')
  input = createInterface({ input: process.stdin, output: process.stdout })
  let operations = Promise.resolve()
  input.on('line', (line) => {
    operations = operations.then(async () => {
      if (abort.signal.aborted) return
      const text = line.trim()
      if (text === 'quit') { finish(); return }
      if (text === 'restart-api' || text === 'crash-api') {
        stage = text
        api.expected = true
        if (text === 'crash-api') await stop(api, 'SIGKILL', 10_000)
        else {
          await stop(api)
          if (!api.closed || api.code !== 0) { preserve = true; throw new Error('API shutdown is not proven.') }
        }
        await startApi()
        console.log('ENG07 API restarted against the SAME database and recovery directories. No seed, new Run or approval replay was submitted.')
        return
      }
      const match = /^parity(?: ([A-Za-z0-9_-]{1,200}))?$/.exec(text)
      if (match) { await probe(match[1]); return }
      console.log('Use restart-api, crash-api, parity [RUN_ID], or quit. Do not enter credentials here.')
    }).catch((error) => {
      console.error(`ENG07 ${stage} failed (${publicError(error)}). Inspect the Board; no automatic command resubmission.`)
      preserve = true; finish(1)
    })
  })
  input.once('close', () => finish())
  await ended
}
main().catch((error) => {
  if (!abort.signal.aborted) console.error(`ENG07 ${stage} failed (${publicError(error)}). See prerequisites and troubleshooting in docs/acceptance/owner-walkthrough.md.`)
  process.exitCode = process.exitCode || 1
}).finally(async () => {
  try { await shutdown() } catch {
    process.exitCode = 1
    console.error('ENG07 cleanup ownership check failed. Nothing further was removed.')
  }
})
