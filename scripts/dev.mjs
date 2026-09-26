import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, copyFile, chmod } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { loadEnvFile } from 'node:process'
import { fileURLToPath } from 'node:url'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const customApiEnv = process.env.GRAPHQL_API_ENV_FILE
const apiEnv = customApiEnv ?? join(root, 'apps/api/.env')
const children = []
let stopping = false

function stop() {
  if (stopping) return
  stopping = true
  for (const { child } of children) {
    try { process.kill(-child.pid, 'SIGTERM') } catch { /* Already stopped. */ }
  }
}

function start(name, args, options = {}) {
  const child = spawn('corepack', ['pnpm', ...args], {
    cwd: root, stdio: 'inherit', detached: true, ...options,
  })
  child.on('error', (error) => { console.error(`${name}: ${error.message}`) })
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ name, code, signal }))
  })
  children.push({ name, child, exited })
  return child
}

async function run(name, args) {
  const child = spawn('corepack', ['pnpm', ...args], { cwd: root, stdio: 'inherit' })
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (exitCode) => resolve(exitCode))
  })
  if (code !== 0) throw new Error(`${name} failed (exit ${code}).`)
}

async function listening(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => resolve(false))
    socket.setTimeout(1000, () => { socket.destroy(); resolve(false) })
  })
}

async function responds(url, accepts) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) })
    return accepts(response, await response.text())
  } catch { return false }
}

export async function runningApiAcceptsBrowserOrigin(apiUrl, browserOrigin, request = fetch) {
  try {
    const response = await request(`${apiUrl}/api/auth/session`, {
      headers: { origin: browserOrigin }, signal: AbortSignal.timeout(2000),
    })
    return response.ok && (await response.text()).includes('"localDev":true')
  } catch { return false }
}

async function waitFor(name, url, accepts, child) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline && !stopping) {
    if (await responds(url, accepts)) return
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(`${name} stopped before becoming ready.`)
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw new Error(`${name} did not become ready at ${url}.`)
}

async function main() {
  if (customApiEnv && !isAbsolute(customApiEnv)) throw new Error('GRAPHQL_API_ENV_FILE must be an absolute path.')
  try {
    await access(apiEnv)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    if (customApiEnv) throw new Error(`GRAPHQL_API_ENV_FILE does not exist: ${apiEnv}`)
    await copyFile(join(root, 'apps/api/.env.example'), apiEnv, constants.COPYFILE_EXCL)
    await chmod(apiEnv, 0o600)
    console.log('Created apps/api/.env from the local example.')
  }
  process.env.GRAPHQL_API_ENV_FILE = apiEnv
  loadEnvFile(apiEnv)
  const port = Number(process.env.PORT ?? 3000)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.')
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is missing from apps/api/.env.')
  const database = new URL(process.env.DATABASE_URL)
  const apiUrl = `http://127.0.0.1:${port}`
  const webUrl = 'http://127.0.0.1:5173'
  const apiLive = (response, body) => response.ok && body.includes('"service":"graphql-api"')
  const apiReady = (response, body) => response.ok && body.includes('"status":"ok"')
  const webReady = (response, body) => response.ok && body.includes('src="/src/main.tsx')

  if (['127.0.0.1', 'localhost'].includes(database.hostname)
      && (database.port || '5432') === '5432' && database.pathname === '/graphql'
      && database.username === 'graphql' && database.password === 'graphql') {
    await run('PostgreSQL', ['db:up'])
  } else {
    console.log('Using the configured PostgreSQL database; Docker Compose was skipped.')
  }
  await run('Contracts build', ['--filter', '@graphql/contracts', 'build'])

  let api
  if (await listening(port)) {
    if (!await responds(`${apiUrl}/health/live`, apiLive)) {
      throw new Error(`Port ${port} is in use by a different or unhealthy service.`)
    }
    if (!await runningApiAcceptsBrowserOrigin(apiUrl, webUrl)) {
      throw new Error(`The API at ${apiUrl} does not allow local development browser access from ${webUrl}. Stop it and restart corepack pnpm dev.`)
    }
    console.log(`Using the GraphQL API already running at ${apiUrl}.`)
  } else {
    api = start('API', ['--filter', '@graphql/api', 'dev'], {
      // Keep API logs on disk by default (.logs/api.*.log) unless the caller chose a destination.
      env: { ...process.env, ...(!process.env.LOG_DIR && !process.env.LOG_FILE ? { LOG_DIR: join(root, '.logs') } : {}),
        GRAPHQL_DEV_BROWSER_ACCESS: '1', GRAPHQL_DEV_BROWSER_ORIGIN: webUrl },
    })
  }
  await waitFor('API', `${apiUrl}/health/ready`, apiReady, api)

  let web
  if (await listening(5173)) {
    if (!await responds(webUrl, webReady)) {
      throw new Error('Port 5173 is in use by a different or unhealthy service.')
    }
    console.log(`Using the GraphQL web server already running at ${webUrl}.`)
  } else {
    web = start('Web', ['--filter', '@graphql/web', 'dev'], {
      env: { ...process.env, VITE_API_URL: apiUrl },
    })
  }
  await waitFor('Web', webUrl, webReady, web)

  if (children.length === 0) {
    console.log('GraphQL is already running.')
    return
  }
  // dev:api and dev:web already own a contracts watcher when one is reused.
  if (api && web) start('Contracts watcher', ['--filter', '@graphql/contracts', 'dev'])
  console.log(`GraphQL ready: ${webUrl} (API ${apiUrl}).`)
  console.log('Local development browser access is active; open the app without signing in.')
  const ended = await Promise.race(children.map(({ exited }) => exited))
  if (!stopping) {
    console.error(`${ended.name} stopped (exit ${ended.code ?? ended.signal}).`)
    process.exitCode = 1
    stop()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  main().catch((error) => {
    stop()
    console.error(`GraphQL dev startup failed: ${error.message}`)
    process.exitCode = 1
  })
}
