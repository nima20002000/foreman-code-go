import { spawn } from 'node:child_process'
import { copyFile, chmod, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { resolveProductEnvironment } from '../packages/contracts/src/productEnvironment.mjs'

export function localProductionEnvironment(desktopHome, password) {
  const current = join(desktopHome, '.local/lib/graphql-production/current')
  const state = join(desktopHome, '.local/state/graphql-production')
  const data = join(desktopHome, '.local/share/graphql-production')
  return {
    NODE_ENV: 'production',
    FOREMAN_CODE_LOCAL_PRODUCTION: '1',
    HOST: '127.0.0.1',
    PORT: '3041',
    DATABASE_URL: `postgresql://graphql_production:${password}@127.0.0.1:55440/graphql_production`,
    // Existing database units invoke Compose directly with this spelling.
    GRAPHQL_PRODUCTION_DB_PASSWORD: password,
    FOREMAN_CODE_BROWSER_ORIGIN: 'http://127.0.0.1:3041',
    FOREMAN_CODE_WEB_DIST: join(current, 'apps/web/dist'),
    WORKSPACE_STORAGE_ROOT: join(data, 'workspaces'),
    FILE_STORAGE_ROOT: join(data, 'files'),
    HARNESS_WORKSPACE_ROOT: join(state, 'runs'),
    // Native entries use one reviewed launcher; each credential selects its own app.
    FOREMAN_CODE_APP_MCP_DIRECTORY: join(desktopHome, '.local/share/graphql/mcp'),
    LOG_DIR: join(state, 'logs'),
    XDG_CACHE_HOME: join(state, 'cache'),
    LANGGRAPH_CHECKPOINT_SCHEMA: 'langgraph',
    FOREMAN_CODE_DEV_BROWSER_ACCESS: '0',
    NODE_OPTIONS: '',
    NODE_PATH: '',
  }
}

export async function deployProductionApi(run, destination) {
  const failures = []
  try {
    await run('corepack', ['pnpm', '--filter', '@foreman-code/api', 'deploy', '--prod', '--legacy', destination])
  } catch (error) {
    failures.push(error)
  }
  // Legacy deployment records production-only settings in the source workspace.
  // Restore them through pnpm before another workspace command checks its dependencies.
  try {
    await run('corepack', ['pnpm', 'install', '--frozen-lockfile'])
  } catch (error) {
    failures.push(error)
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'Production deployment and workspace restoration failed.')
}

export async function publish(path, content, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const directory = await mkdtemp(`${path}.temporary-`)
  const temporary = join(directory, 'content')
  try {
    await writeFile(temporary, content, { mode, flag: 'wx' })
    await chmod(temporary, mode)
    await rename(temporary, path)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export async function withInstallationLock(path, action) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const handle = await open(path, 'a', 0o600)
  try {
    // flock and this process share the open file description, so the lock lasts
    // until the parent closes it, including if the parent exits unexpectedly.
    await new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/flock', ['--exclusive', '3'], {
        stdio: ['ignore', 'inherit', 'inherit', handle.fd],
      })
      child.once('error', reject)
      child.once('exit', code => code === 0 ? resolve() : reject(new Error('Installation lock failed.')))
    })
    return await action()
  } finally {
    await handle.close()
  }
}

function environmentValue(content, start) {
  let value = ''
  let mode = 'leading'
  let trailingWhitespace
  let offset = start
  for (; offset < content.length; offset += 1) {
    const character = content[offset]
    const quoted = mode === 'single' || mode === 'double'
    if (quoted) {
      const quote = mode === 'single' ? "'" : '"'
      if (character === quote) {
        mode = 'leading'
      } else if (mode === 'double' && character === '\\') {
        const escaped = content[++offset]
        if (escaped !== undefined && escaped !== '\n') {
          value += '"\\`$'.includes(escaped) ? escaped : `\\${escaped}`
        }
      } else {
        value += character
      }
      continue
    }
    if (character === '\n') break
    if (mode === 'leading') {
      if (' \t\r'.includes(character)) continue
      if (character === "'" || character === '"') {
        mode = character === "'" ? 'single' : 'double'
        continue
      }
      mode = 'unquoted'
    }
    if (character === '\\') {
      trailingWhitespace = undefined
      const escaped = content[++offset]
      if (escaped !== undefined && escaped !== '\n') value += escaped
    } else {
      if (' \t\r'.includes(character)) trailingWhitespace ??= value.length
      else trailingWhitespace = undefined
      value += character
    }
  }
  if (mode === 'unquoted' && trailingWhitespace !== undefined) value = value.slice(0, trailingWhitespace)
  return { value, end: offset }
}

function parseEnvironment(content) {
  const assignments = /(?:^|\n)[ \t\r]*([A-Za-z_][A-Za-z0-9_]*)[ \t\r]*=/g
  const entries = []
  for (let match = assignments.exec(content); match; match = assignments.exec(content)) {
    const parsed = environmentValue(content, assignments.lastIndex)
    entries.push([match[1], parsed.value])
    assignments.lastIndex = parsed.end
  }
  return Object.fromEntries(entries)
}

export async function readEnvironment(path) {
  try {
    // production.env is an EnvironmentFile, whose quoting differs from dotenv.
    return parseEnvironment(await readFile(path, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

export async function preserveOperatorConfiguration(path, previous, owned, validate) {
  const canonicalName = key => key.replace(/^GRAPHQL_/, 'FOREMAN_CODE_')
  const managed = new Set(Object.keys(owned).map(canonicalName))
  resolveProductEnvironment(previous ?? {})
  let configuration
  try {
    configuration = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    configuration = Object.fromEntries(Object.entries(previous ?? {}).filter(([key]) => !managed.has(canonicalName(key))))
  }
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) {
    throw new Error('Operator configuration must be an object of environment settings.')
  }
  for (const [key, value] of Object.entries(configuration)) {
    if (managed.has(canonicalName(key))) {
      throw new Error(`${key} is managed by the installer; remove it from operator.json.`)
    }
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0')) {
      throw new Error(`Invalid operator setting: ${key}.`)
    }
  }
  const environment = { ...configuration, ...owned }
  resolveProductEnvironment(environment)
  await validate(environment)
  await publish(path, JSON.stringify(configuration, null, 2) + '\n')
  return environment
}

export function renderEnvironment(environment) {
  return Object.entries(environment).map(([key, value]) => {
    const quoted = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
    return `${key}="${quoted}"`
  }).join('\n') + '\n'
}

export async function readProductionIdentity(release, databaseUrl) {
  const require = createRequire(join(release, 'apps/api/package.json'))
  const { Pool } = require('pg')
  const { readRuntimeIdentity } = await import(pathToFileURL(join(release, 'apps/api/dist/infrastructure/runtimeIdentity.js')))
  const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000,
    query_timeout: 5000 })
  try {
    return await readRuntimeIdentity(pool, release, databaseUrl)
  } finally {
    await pool.end()
  }
}

export async function waitForProductionReady({ origin, expected, timeoutMs = 90_000 }) {
  const deadline = Date.now() + timeoutMs
  let failure = 'API has not responded.'
  const identityMatches = async () => {
    const response = await fetch(`${origin}/health/identity`, { signal: AbortSignal.timeout(2000) })
    const actual = await response.json()
    return response.ok && ['installationId', 'databaseId', 'checkoutId'].every(key => actual[key] === expected[key])
  }
  while (Date.now() < deadline) {
    try {
      if (!await identityMatches()) {
        throw new Error('Port 3041 is serving a different database installation or release.')
      }
      const response = await fetch(`${origin}/health/ready`, { signal: AbortSignal.timeout(2000) })
      const health = await response.json()
      if (response.ok && health.service === 'graphql-api' && health.checks?.database === 'ok'
        && health.checks?.checkpoints === 'ok') {
        const web = await fetch(`${origin}/workspaces`, { signal: AbortSignal.timeout(2000) })
        if (web.ok && (await web.text()).includes('/assets/') && await identityMatches()) return
        failure = 'The compiled dashboard is unavailable.'
      } else failure = `Readiness returned HTTP ${response.status}.`
    } catch (error) {
      failure = error.message
    }
    await delay(Math.min(500, Math.max(0, deadline - Date.now())))
  }
  throw new Error(`${failure} Inspect journalctl --user -u graphql-operator-api.service.`)
}

export async function copyVerificationRuntime(source, release) {
  await mkdir(join(release, 'scripts'), { recursive: true })
  for (const name of ['verification-runner.mjs', 'verification-reports.mjs', 'integration-process.mjs']) {
    await copyFile(join(source, 'scripts', name), join(release, 'scripts', name))
  }
}
