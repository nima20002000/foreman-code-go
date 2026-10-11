import { spawn } from 'node:child_process'
import { chmod, copyFile, cp, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { readProductEnvironment, resolveProductEnvironment } from '../packages/contracts/src/productEnvironment.mjs'

export function shouldOpenDashboardAfterInstall({ previousRelease, stdin, stdout }) {
  return !previousRelease && stdin.isTTY === true && stdout.isTTY === true
}

export function productionIntegrationPaths(home, environment) {
  const config = environment.XDG_CONFIG_HOME || join(home, '.config')
  const data = environment.XDG_DATA_HOME || join(home, '.local/share')
  if (!isAbsolute(config) || !isAbsolute(data)) {
    throw new Error('XDG_CONFIG_HOME and XDG_DATA_HOME must be absolute paths.')
  }
  return {
    units: join(config, 'systemd/user'),
    desktop: join(data, 'applications/graphql-production.desktop'),
    autostart: join(config, 'autostart/graphql-production.desktop'),
    icon: join(data, 'icons/hicolor/scalable/apps/graphql-production.svg'),
  }
}

export async function publishDesktopIntegration(paths, { desktop, autostart, icon, firstInstall }) {
  await publish(paths.icon, icon, 0o644)
  await publish(paths.desktop, desktop, 0o644)
  // Updates leave both deleted entries and user-edited startup preferences intact.
  if (firstInstall) await publish(paths.autostart, autostart, 0o644)
}

export async function enableProductionServices(run, units, { firstInstall }) {
  if (firstInstall) await run('/usr/bin/systemctl', ['--user', 'enable', ...units])
}

export async function launchProduction({ lockPath, start, ready, openDashboard, timeoutMs = 90_000 }) {
  await withInstallationLock(lockPath, async () => {
    const deadline = Date.now() + timeoutMs
    let failure
    while (Date.now() < deadline) {
      try {
        await start()
        await ready(Math.min(2000, Math.max(1, deadline - Date.now())))
        await openDashboard()
        return
      } catch (error) {
        failure = error
        // A healthy backend with a failed browser handoff must not spawn repeated browsers.
        if (error.browserLaunchFailed) throw error
      }
      await delay(Math.min(500, Math.max(0, deadline - Date.now())))
    }
    throw new Error(`Foreman Code could not become ready. ${failure?.message ?? ''}`)
  }, { timeoutMs })
}

export function launchBrowser(command, args, { environment, observeMs = 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: ['ignore', 'ignore', 'pipe'], env: environment })
    let diagnostic = ''
    let timer
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stderr?.unref?.()
      child.unref()
      if (error) {
        error.browserLaunchFailed = true
        reject(error)
      } else resolve()
    }
    child.stderr?.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-4096) })
    child.once('error', () => finish(new Error('The backend is ready, but Chrome could not be started.')))
    child.once('exit', (code, signal) => {
      if (code === 0) return finish()
      let guidance = 'Check the desktop session and Chrome profile.'
      if (/display|X server|ozone_platform/i.test(diagnostic)) guidance = 'Check that a graphical desktop session is available.'
      else if (/Singleton|profile|ProcessSingleton/i.test(diagnostic)) guidance = 'Check that the Chrome profile is available.'
      finish(new Error(`The backend is ready, but Chrome exited (${signal ?? code}). ${guidance}`))
    })
    child.once('spawn', () => { timer = setTimeout(() => finish(), observeMs) })
  })
}

export function desktopLaunchEnvironment(source) {
  const environment = { ...source }
  if (!readProductEnvironment(source, 'HEAVY_JOB_TOKEN')) return environment
  const baseTemporaryDirectory = readProductEnvironment(source, 'HEAVY_BASE_TMPDIR')
  for (const name of ['TMPDIR', 'TMP', 'TEMP']) {
    if (baseTemporaryDirectory) environment[name] = baseTemporaryDirectory
    else delete environment[name]
  }
  for (const name of Object.keys(environment)) {
    if (/^(?:FOREMAN_CODE|GRAPHQL)_HEAVY_/.test(name)) delete environment[name]
  }
  return environment
}

export function hasNativeTurnStarted(harness, execution, event) {
  const session = execution.nativeSessionId
  if (!session || event.executionId !== execution.id || event.connectionId?.startsWith('history-')) return false
  if (harness === 'codex') return event.type === 'turn.started' && event.payload.threadId === session
  if (harness === 'claude') return event.type === 'claude.text'
    && event.payload.role !== 'user' && Boolean(event.payload.text) && event.payload.nativeSessionId === session
  return false
}

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
    NODE_OPTIONS: '',
    NODE_PATH: '',
  }
}

export async function deployProductionApi(run, destination) {
  const failures = []
  try {
    await run('corepack', ['pnpm', '--filter', '@foreman-code/api', 'deploy', '--prod', '--legacy', destination])
    // Freeze mutable workspace files; pnpm already isolates installed dependencies.
    const contracts = await realpath(join(destination, 'node_modules/@foreman-code/contracts'))
    for (const packageDirectory of [destination, contracts]) {
      const temporary = await mkdtemp(join(dirname(packageDirectory), '.production-package-copy-'))
      try {
        const snapshot = join(temporary, 'package')
        const dependencies = join(packageDirectory, 'node_modules')
        const entries = await readdir(packageDirectory)
        await cp(packageDirectory, snapshot, { recursive: true, verbatimSymlinks: true,
          filter: source => source !== dependencies })
        if (entries.includes('node_modules')) await rename(dependencies, join(snapshot, 'node_modules'))
        await rm(packageDirectory, { recursive: true })
        await rename(snapshot, packageDirectory)
      } finally {
        await rm(temporary, { recursive: true, force: true })
      }
    }
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

export async function removeUninstalledRelease(release, current) {
  let installed
  try {
    installed = await realpath(current)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (installed === await realpath(release)) return
  await rm(release, { recursive: true, force: true })
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

export async function withInstallationLock(path, action, { timeoutMs } = {}) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const handle = await open(path, 'a', 0o600)
  try {
    // flock and this process share the open file description, so the lock lasts
    // until the parent closes it, including if the parent exits unexpectedly.
    await new Promise((resolve, reject) => {
      const args = ['--exclusive', ...(timeoutMs ? ['--wait', String(timeoutMs / 1000)] : []), '3']
      const child = spawn('/usr/bin/flock', args, {
        stdio: ['ignore', 'inherit', 'inherit', handle.fd],
      })
      child.once('error', reject)
      child.once('exit', code => code === 0 ? resolve() : reject(new Error('An installation is still in progress. Try again later.')))
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
  const keepSetting = ([key]) => canonicalName(key) !== 'FOREMAN_CODE_DEV_BROWSER_ACCESS'
  const managed = new Set(Object.keys(owned).map(canonicalName))
  const previousSettings = Object.fromEntries(Object.entries(previous ?? {}).filter(keepSetting))
  resolveProductEnvironment(previousSettings)
  let configuration
  try {
    configuration = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    configuration = Object.fromEntries(Object.entries(previousSettings).filter(([key]) => !managed.has(canonicalName(key))))
  }
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) {
    throw new Error('Operator configuration must be an object of environment settings.')
  }
  configuration = Object.fromEntries(Object.entries(configuration).filter(keepSetting))
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

/**
 * An API restart closes every native agent process it owns, and their Runs fail without replay.
 * Install therefore waits until no Run is queued, running or waiting, unless the operator accepts the interruption.
 */
export async function waitForIdleRuns({ query, timeoutMs, pollMs = 15_000, interrupt = false, log = console.log, sleep = delay }) {
  if (interrupt) return
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const active = (await query("select id from runs where execution_state in ('queued','running','waiting') order by id")).rows.map(row => row.id)
    if (!active.length) return
    if (Date.now() >= deadline) {
      throw new Error(`${active.length} Run(s) still active (${active.join(', ')}). Restarting the API would interrupt them. `
        + 'Let them finish, stop them, or rerun with FOREMAN_INSTALL_INTERRUPT_RUNS=1.')
    }
    log(`Waiting for ${active.length} active Run(s) to finish before restarting the API: ${active.join(', ')}`)
    await sleep(pollMs)
  }
}

export async function readActiveRuns(release, databaseUrl, wait) {
  const require = createRequire(join(release, 'apps/api/package.json'))
  const { Pool } = require('pg')
  const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000, query_timeout: 5000 })
  try {
    await wait((text) => pool.query(text))
  } finally {
    await pool.end()
  }
}

/** Each install stages a full release (~1 GB). Keep the running one and the previous one for rollback; remove the rest. */
export async function pruneReleases(releasesDirectory, keep) {
  const kept = new Set(keep.filter(Boolean))
  const removed = []
  for (const name of await readdir(releasesDirectory)) {
    const path = join(releasesDirectory, name)
    if (!name.startsWith('release-') || kept.has(path)) continue
    await rm(path, { recursive: true, force: true })
    removed.push(path)
  }
  return removed
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
  const paths = ['scripts/verification-runner.mjs', 'scripts/verification-reports.mjs',
    'scripts/integration-process.mjs', 'scripts/integration-capabilities.mjs',
    'apps/worker/src/diagnostics.mjs', 'packages/contracts/src/verificationEnvironment.mjs',
    'packages/contracts/src/integrationScheduling.mjs']
  for (const path of paths) {
    const destination = join(release, path)
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(join(source, path), destination)
  }
}
