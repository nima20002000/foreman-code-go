import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, posix, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { groupUsed, integrationProcessLimits, integrationProcessProgress, stopGroup,
  superviseIntegrationProcess } from './integration-process.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const startupFile = 'apps/api/test/dev-startup.integration.test.ts'
const require = createRequire(new URL('../apps/api/package.json', import.meta.url))
const { Pool } = require('pg')

export function isIntegrationTestPath(file) {
  if (!file.startsWith('apps/api/test/') || !file.endsWith('.integration.test.ts')) return false
  return posix.normalize(file) === file && file.split('/').every((part) => part && part !== '.' && part !== '..')
}

export function isRegularIntegrationFile(base, file) {
  if (!isIntegrationTestPath(file)) return false
  try {
    let path = base
    for (const part of file.split('/')) {
      path = join(path, part)
      if (lstatSync(path).isSymbolicLink()) return false
    }
    return lstatSync(path).isFile()
  } catch { return false }
}

export function discoverFiles() {
  const result = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'apps/api/test'], { cwd: root })
  if (result.status !== 0) throw new Error('Could not discover tracked integration files')
  const files = result.stdout.toString('utf8').split('\0').filter((file) => isRegularIntegrationFile(root, file)).sort()
  if (!files.length || !files.includes(startupFile)) throw new Error('Integration file discovery is incomplete')
  return files
}

export function selectFiles(files, startAt) {
  if (!startAt) return files
  if (!files.includes(startAt)) throw new Error(`Unknown --start-at integration file: ${startAt}`)
  return files.slice(files.indexOf(startAt))
}

export function selectExactFiles(files, requested) {
  const known = new Set(files)
  for (const file of requested) {
    if (!known.has(file)) throw new Error(`Unknown --files integration file: ${file}`)
  }
  return [...new Set(requested)].sort()
}

export function failedFilesFromLog(output, files) {
  const known = new Set(files)
  const failed = new Set()
  for (const line of output.split(/\r?\n/)) {
    const match = /^\[integration\] FAIL (.*) \(slot \d+, exit /.exec(line)
    if (!match) continue
    if (!known.has(match[1])) throw new Error(`Unknown failed integration file: ${match[1]}`)
    failed.add(match[1])
  }
  if (!failed.size) throw new Error('The integration log contains no failed files')
  return [...failed].sort()
}

export function integrationLogPath(base, file) {
  if (!isIntegrationTestPath(file)) throw new Error(`Invalid integration log path: ${file}`)
  return join(base, `${file.slice('apps/api/test/'.length)}.log`)
}

export function adminDatabaseUrl(testDatabaseUrl) {
  if (!testDatabaseUrl) return 'postgresql://graphql:graphql@127.0.0.1:5432/postgres'
  const url = new URL(testDatabaseUrl)
  url.pathname = '/postgres'
  return url.toString()
}

/** Failing case names from a Vitest log, so failures can be acted on while the run continues. */
export function failedCasesFromLog(output) {
  const names = output.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)
    .map((line) => /^\s*FAIL\s+\S+\s+>\s+(.+)$/.exec(line)?.[1].trim()).filter(Boolean)
  return [...new Set(names)]
}

export function parseVitestCases(output) {
  const lines = output.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)
  const line = lines.findLast((item) => /^\s*Tests\s+.*\(\d+\)\s*$/.test(item))
  if (!line) return null
  const counts = { passed: 0, failed: 0, skipped: 0 }
  for (const match of line.matchAll(/(\d+)\s+(passed|failed|skipped|todo|pending)/g)) {
    counts[match[2] === 'todo' || match[2] === 'pending' ? 'skipped' : match[2]] += Number(match[1])
  }
  const total = Number(line.match(/\((\d+)\)\s*$/)[1])
  return counts.passed + counts.failed + counts.skipped === total ? { ...counts, total } : null
}

export function failForSkippedCases(summary, startAt) {
  return !startAt && Boolean(summary?.skipped)
}

export function autoRetestFiles(failedFiles, { diagnostic, interrupted }) {
  return diagnostic || interrupted ? [] : [...new Set(failedFiles)].sort()
}

export function fullRunExitCode(failed, interrupted) {
  return interrupted === 'SIGINT' ? 130 : interrupted ? 143 : failed ? 1 : 0
}

export function integrationShardLimit(value) {
  const limit = value === undefined ? 12 : Number(value)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 12) throw new Error('Integration shards must be an integer from 1 to 12')
  return limit
}

export async function scheduleFiles(files, slots, runFile, shouldStop = () => false) {
  let next = 0
  const outcomes = []
  await Promise.all(slots.map(async (slot) => {
    while (!shouldStop() && next < files.length) {
      const file = files[next++]
      let result
      try { result = await runFile(slot, file) }
      catch (error) { result = { code: 1, error } }
      outcomes.push({ slot, file, ...result })
      if (result.slotUnavailable) break
    }
  }))
  return { outcomes, skipped: files.length - next, unexecuted: files.slice(next) }
}

export function integrationTimeouts(environment) {
  const timeouts = { ...integrationProcessLimits }
  for (const [setting, variable] of [
    ['idleTimeoutMs', 'GRAPHQL_INTEGRATION_IDLE_TIMEOUT_MS'],
    ['fileTimeoutMs', 'GRAPHQL_INTEGRATION_FILE_TIMEOUT_MS'],
  ]) {
    if (environment[variable] === undefined) continue
    const value = Number(environment[variable])
    if (!Number.isSafeInteger(value) || value < 1000 || value > 60 * 60_000) {
      throw new Error(`${variable} must be an integer from 1000 to 3600000 ms`)
    }
    timeouts[setting] = value
  }
  return timeouts
}

export function integrationProgressLine({ phase, total, passed, failed, active, slotCount,
  usableCount = slotCount }, now = Date.now()) {
  const completed = passed + failed
  const queued = Math.max(0, total - completed - active.size)
  const running = [...active].map(([index, { file, progress }]) => {
    const elapsed = Math.floor((now - progress.started) / 1000)
    const idle = Math.floor((now - progress.lastOutputAt) / 1000)
    return `slot ${index}: ${file}, elapsed ${elapsed}s, output idle ${idle}s, ${progress.bytes} bytes`
  })
  const summary = `[integration] PROGRESS ${phase}: ${completed}/${total} completed`
    + ` (${passed} passed, ${failed} failed); ${active.size}/${slotCount} slots active; ${queued} queued`
    + (usableCount < slotCount ? `; ${slotCount - usableCount} retired` : '')
  return `${summary}${running.length ? `; ${running.join('; ')}` : ''}.`
}

function procStart(pid) {
  try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[19] } catch { return null }
}

export function hasActiveHeavyJobToken(environment, common, owner) {
  return Boolean(owner?.token && environment.GRAPHQL_HEAVY_JOB_COMMON === common
    && environment.GRAPHQL_HEAVY_JOB_TOKEN === owner.token
    && owner.pid > 0 && procStart(owner.pid) === owner.start)
}

export function hasHeavyJobAdmission(environment, common) {
  const state = join(common, 'graphql-heavy-jobs')
  const paths = [join(state, 'active', 'owner.json')]
  try { paths.push(...readdirSync(join(state, 'running')).map((name) => join(state, 'running', name))) } catch { /* no secondary slots */ }
  return paths.some((path) => {
    try {
      const owner = JSON.parse(readFileSync(path, 'utf8'))
      return owner?.common === common && hasActiveHeavyJobToken(environment, common, owner)
    } catch { return false }
  })
}

export function signalOwnedChildren(active, timers, signal, graceMs = 5000) {
  for (const [index, { child }] of active) {
    if (!child.pid) continue
    try { process.kill(-child.pid, signal) } catch { /* already exited */ }
    if (!timers.has(index)) timers.set(index, setTimeout(() => {
      if (groupUsed(child.pid)) { try { process.kill(-child.pid, 'SIGKILL') } catch { /* already exited */ } }
    }, graceMs))
  }
}

function requireLoopbackTestDatabase(url) {
  const parsed = new URL(url)
  const databaseName = decodeURIComponent(parsed.pathname.slice(1))
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
    || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
    || !/(?:^|[_-])test(?:db)?(?:$|[_-])/i.test(databaseName)
    || parsed.search || parsed.hash) {
    throw new Error('Use a loopback PostgreSQL database explicitly named for tests')
  }
}

export function integrationEnvironment(environment, slot) {
  requireLoopbackTestDatabase(slot.databaseUrl)
  return { ...environment, TEST_DATABASE_URL: slot.databaseUrl,
    JOB_DISPATCH_DATABASE_URL: slot.databaseUrl,
    NIM2691_POSTGRES: '1', NIM2691_ADMIN_DATABASE_URL: slot.databaseUrl,
    HRT_F14_ADMIN_DATABASE_URL: slot.databaseUrl,
    TMPDIR: slot.directory, TMP: slot.directory, TEMP: slot.directory }
}

function options(argv) {
  const startAt = process.env.GRAPHQL_INTEGRATION_START_AT || null
  const failedFrom = process.env.GRAPHQL_INTEGRATION_FAILED_LOG || null
  if (!argv.length) {
    if (startAt && failedFrom) throw new Error('Choose either a resume cursor or a failed-file log')
    return { startAt, failedFrom, files: null }
  }
  if (argv[0] === '--files' && argv.length > 1 && !startAt && !failedFrom) {
    return { startAt: null, failedFrom: null, files: argv.slice(1) }
  }
  if (argv.length === 2 && argv[0] === '--start-at' && argv[1] && !failedFrom) return { startAt: argv[1], failedFrom: null }
  if (argv.length === 2 && argv[0] === '--failed-from' && argv[1] && !startAt) return { startAt: null, failedFrom: argv[1] }
  throw new Error('Usage: test-integration.mjs [--files <integration files...> | --start-at <integration file> | --failed-from <runner log>]')
}

async function main() {
  const { startAt, failedFrom, files } = options(process.argv.slice(2))
  const commonResult = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' })
  if (commonResult.status !== 0) throw new Error('Could not find the project heavy-job queue')
  const common = realpathSync(commonResult.stdout.trim())
  if (!hasHeavyJobAdmission(process.env, common)) {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./heavy-job.mjs', import.meta.url)), '--timeout-ms', '9000000', '--', process.execPath, import.meta.filename, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env })
    process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code) => resolve(code ?? 1)) })
    return
  }
  const allFiles = discoverFiles()
  let selected = selectFiles(allFiles, startAt)
  if (failedFrom) selected = failedFilesFromLog(readFileSync(failedFrom, 'utf8'), allFiles)
  if (files) selected = selectExactFiles(allFiles, files)
  const diagnostic = Boolean(startAt || failedFrom)
  // TEST_DATABASE_URL only selects the loopback server; every slot still gets
  // its own disposable database there, so the run stays fully parallel.
  if (process.env.TEST_DATABASE_URL) requireLoopbackTestDatabase(process.env.TEST_DATABASE_URL)
  const shardCount = Math.min(integrationShardLimit(process.env.GRAPHQL_INTEGRATION_SHARDS), selected.length)
  const timeouts = integrationTimeouts(process.env)
  const adminUrl = adminDatabaseUrl(process.env.TEST_DATABASE_URL)
  const admin = new Pool({ connectionString: adminUrl, max: 1,
    connectionTimeoutMillis: 10_000, query_timeout: 35_000,
    options: '-c statement_timeout=30000 -c lock_timeout=10000' })
  const slots = []
  const active = new Map()
  const killTimers = new Map()
  const tempRoot = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'graphql-integration-'))
  const failedLogs = join(root, '.logs', 'test-integration', randomUUID())
  let interrupted = null
  const interrupt = (signal) => {
    interrupted ??= signal
    signalOwnedChildren(active, killTimers, signal)
  }
  const onSigint = () => interrupt('SIGINT')
  const onSigterm = () => interrupt('SIGTERM')
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)
  let passed = 0
  let failed = 0
  let skipped = 0
  let unreported = 0
  const failedFiles = []
  const retestFailedFiles = new Set()
  const cases = { passed: 0, failed: 0, skipped: 0 }
  const retest = { passed: 0, failed: 0, skipped: 0 }
  let phase = 'first pass'
  let phaseTotal = selected.length
  let heartbeat
  const reportProgress = () => {
    const counts = phase.startsWith('retest') ? retest : { passed, failed }
    console.log(integrationProgressLine({ phase, total: phaseTotal, ...counts, active, slotCount: shardCount,
      usableCount: slots.filter((slot) => !slot.unavailable).length }))
  }
  const resetSlotDatabase = async (slot) => {
    if (slot.name) await admin.query(`drop database "${slot.name}" with (force)`)
    slot.name = `graphql_test_${randomUUID().replaceAll('-', '')}`
    await admin.query(`create database "${slot.name}"`)
    const connection = new URL(adminUrl)
    connection.pathname = `/${slot.name}`
    slot.databaseUrl = connection.toString()
    delete slot.resetError
  }
  const recordUnexecuted = (files, phase = 'first') => {
    const isRetest = phase === 'retest'
    for (const file of files) {
      if (isRetest) {
        if (!retestFailedFiles.has(file)) {
          retest.failed++
          retestFailedFiles.add(file)
        }
      } else {
        failed++
        unreported++
        failedFiles.push(file)
      }
      console.error(`[integration] ${isRetest ? 'RETEST ' : ''}FAIL ${file} (slot 0, exit 1);`
        + ' not executed: no usable integration slots; log: unavailable')
    }
  }
  try {
    for (let index = 0; index < shardCount; index++) {
      if (interrupted) throw new Error(`Interrupted during database setup (${interrupted})`)
      const directory = join(tempRoot, `slot-${index + 1}`)
      mkdirSync(directory)
      const name = `graphql_test_${randomUUID().replaceAll('-', '')}`
      await admin.query(`create database "${name}"`)
      const connection = new URL(adminUrl)
      connection.pathname = `/${name}`
      slots.push({ index: index + 1, directory, name, databaseUrl: connection.toString() })
    }
    console.log(`[integration] ${allFiles.length} files discovered; ${selected.length} selected; ${shardCount} ${shardCount === 1 ? 'slot' : 'slots'}.`)
    console.log(`[integration] process watchdog: ${timeouts.idleTimeoutMs} ms without output; ${timeouts.fileTimeoutMs} ms per file.`)
    heartbeat = setInterval(reportProgress, 30_000)
    if (startAt) console.log(`[integration] RESUME at ${startAt}: partial run only; a clean full run is required for suite proof.`)
    if (failedFrom) console.log(`[integration] RETEST ${selected.length} failed files from ${failedFrom}: partial run only; a clean full run is required for suite proof.`)
    const runFile = async (slot, file, phase = 'first') => {
      if (interrupted) return { code: 128 + (interrupted === 'SIGINT' ? 2 : 15) }
      if (active.has(slot.index)) throw new Error(`Slot ${slot.index} still has an owned process group`)
      if (slot.unavailable) throw new Error(`Slot ${slot.index} is retired`)
      const started = Date.now()
      const isRetest = phase === 'retest'
      const label = isRetest ? 'RETEST ' : ''
      const log = integrationLogPath(slot.directory, file)
      mkdirSync(dirname(log), { recursive: true })
      const fd = openSync(log, 'w', 0o600)
      const environment = integrationEnvironment(process.env, slot)
      // One slot is one case; it.concurrent must not multiply its SQL fixture load.
      const child = spawn('corepack', ['pnpm', '--filter', '@graphql/api', 'exec', 'vitest', 'run', file.replace('apps/api/', ''), '--no-file-parallelism', '--maxWorkers=1', '--maxConcurrency=1', '--reporter=verbose', '--fsModuleCache'], { cwd: root, env: environment, detached: true, stdio: ['ignore', fd, fd] })
      closeSync(fd)
      const progress = integrationProcessProgress()
      active.set(slot.index, { child, file, progress })
      console.log(`[integration] ${label}START ${file} (slot ${slot.index}, pid ${child.pid ?? 'unavailable'}); log: ${log}`)
      if (interrupted) signalOwnedChildren(active, killTimers, interrupted)
      const result = await superviseIntegrationProcess(child, { log, progress, ...timeouts,
        onTimeout: (reason) => console.error(`[integration] ${label}TIMEOUT ${file} (slot ${slot.index}): ${reason.message}`),
        resetAfterTimeout: async () => {
          try { await resetSlotDatabase(slot) }
          catch (reason) { slot.resetError = reason; throw reason }
          console.log(`[integration] slot ${slot.index} database reset after timeout; remaining queue continues.`)
        },
      })
      let code = result.code
      let error = result.error
      clearTimeout(killTimers.get(slot.index))
      killTimers.delete(slot.index)
      if (!groupUsed(child.pid)) active.delete(slot.index)
      if (result.slotUnavailable) {
        slot.unavailable = true
        console.error(`[integration] slot ${slot.index} RETIRED; healthy slots continue the remaining queue.`)
      }
      const retained = integrationLogPath(join(failedLogs, 'slots', `${isRetest ? 'retest-' : ''}slot-${slot.index}`), file)
      mkdirSync(dirname(retained), { recursive: true })
      copyFileSync(log, retained)
      const elapsedMs = Date.now() - started
      const summary = parseVitestCases(readFileSync(log, 'utf8'))
      if (!isRetest) {
        if (summary) for (const kind of ['passed', 'failed', 'skipped']) cases[kind] += summary[kind]
        else unreported++
      }
      if (code === 0 && !summary) { code = 1; error = new Error('Vitest case summary missing') }
      if (code === 0 && failForSkippedCases(summary, diagnostic)) { code = 1; error = new Error(`${summary.skipped} skipped cases in a full integration run`) }
      if (code === 0) {
        if (isRetest) retest.passed++
        else passed++
        console.log(`[integration] ${label}PASS ${file} (slot ${slot.index}; ${summary.passed} cases passed, ${summary.skipped} skipped; ${elapsedMs} ms)`)
      }
      else {
        if (isRetest) {
          if (!retestFailedFiles.has(file)) { retest.failed++; retestFailedFiles.add(file) }
        } else { failed++; failedFiles.push(file) }
        const saved = integrationLogPath(isRetest ? join(failedLogs, 'retest') : failedLogs, file)
        mkdirSync(dirname(saved), { recursive: true })
        copyFileSync(log, saved)
        console.error(`[integration] ${label}FAIL ${file} (slot ${slot.index}, exit ${code}); ${elapsedMs} ms; log: ${saved}`)
        for (const name of failedCasesFromLog(readFileSync(log, 'utf8'))) console.error(`[integration]   × ${name}`)
        if (error) console.error(`[integration] ${error.message}`)
        if (result.resetError) console.error(`[integration] ${result.resetError.message}`)
      }
      return { code, slotUnavailable: result.slotUnavailable }
    }
    const runSafely = async (slot, file, phase = 'first') => {
      try { return await runFile(slot, file, phase) }
      catch (error) {
        const owned = active.get(slot.index)
        if (owned && !groupUsed(owned.child.pid)) active.delete(slot.index)
        if (active.has(slot.index) || slot.resetError) slot.unavailable = true
        const isRetest = phase === 'retest'
        if (isRetest) {
          if (!retestFailedFiles.has(file)) { retest.failed++; retestFailedFiles.add(file) }
        } else if (!failedFiles.includes(file)) { failed++; failedFiles.push(file) }
        const log = integrationLogPath(slot.directory, file)
        const saved = integrationLogPath(isRetest ? join(failedLogs, 'retest') : failedLogs, file)
        let retained = 'unavailable'
        if (existsSync(log)) {
          try {
            mkdirSync(dirname(saved), { recursive: true })
            copyFileSync(log, saved)
            retained = saved
          } catch { /* report the file failure even if log retention also fails */ }
        }
        console.error(`[integration] ${isRetest ? 'RETEST ' : ''}FAIL ${file} (slot ${slot.index}, exit 1); log: ${retained}`)
        console.error(`[integration] runner error: ${error instanceof Error ? error.message : String(error)}`)
        return { code: 1, error, slotUnavailable: slot.unavailable }
      }
    }
    const firstStartup = selected.includes(startupFile)
    if (firstStartup) {
      phase = 'startup (exclusive)'
      await runSafely(slots[0], startupFile)
      if (interrupted) { skipped = selected.length - 1; return }
    }
    phase = 'first pass'
    const parallel = selected.filter((file) => file !== startupFile)
    const result = await scheduleFiles(parallel, slots.filter((slot) => !slot.unavailable),
      runSafely, () => Boolean(interrupted))
    skipped = interrupted ? result.skipped : 0
    if (!interrupted) recordUnexecuted(result.unexecuted)
    for (const outcome of result.outcomes) if (outcome.code !== 0 && !failedFiles.includes(outcome.file)) {
      failed++
      failedFiles.push(outcome.file)
      console.error(`[integration] FAIL ${outcome.file} (slot ${outcome.slot.index}, exit 1); log: unavailable`)
      if (outcome.error) console.error(`[integration] runner error: ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`)
    }
    const toRetest = autoRetestFiles(failedFiles, { diagnostic, interrupted })
    if (toRetest.length) {
      phase = 'retest setup'
      phaseTotal = toRetest.length
      retest.skipped = toRetest.length
      console.log(`[integration] RETEST ${toRetest.length} first-pass failed files on fresh disposable databases.`)
      const retestSlots = []
      const candidates = slots.filter((slot) => !slot.unavailable).slice(0, toRetest.length)
      for (const slot of candidates) {
        if (interrupted) break
        try {
          await resetSlotDatabase(slot)
          slot.directory = join(tempRoot, `retest-slot-${slot.index}`)
          mkdirSync(slot.directory)
          retestSlots.push(slot)
        } catch (error) {
          slot.unavailable = true
          slot.resetError = error
          console.error(`[integration] slot ${slot.index} RETIRED during retest setup: ${error.message}`)
        }
      }
      if (!interrupted) {
        phase = 'retest'
        reportProgress()
        const retestStartup = toRetest.includes(startupFile)
        if (retestStartup && retestSlots.length) {
          phase = 'retest startup (exclusive)'
          await runSafely(retestSlots[0], startupFile, 'retest')
        }
        phase = 'retest'
        const retestParallel = toRetest.filter((file) => file !== startupFile || !retestSlots.length)
        const retestResult = await scheduleFiles(retestParallel, retestSlots.filter((slot) => !slot.unavailable),
          (slot, file) => runSafely(slot, file, 'retest'), () => Boolean(interrupted))
        retest.skipped = interrupted ? retestResult.skipped : 0
        if (!interrupted) recordUnexecuted(retestResult.unexecuted, 'retest')
      }
    }
  } finally {
    clearInterval(heartbeat)
    let cleanupError
    for (const [index, { child }] of active) {
      try { await stopGroup(child.pid, { signal: interrupted || 'SIGTERM' }); active.delete(index) }
      catch (error) { cleanupError ??= error }
    }
    for (const timer of killTimers.values()) clearTimeout(timer)
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
    try {
      if (!cleanupError) {
        for (const slot of slots) if (slot.name) {
          try { await admin.query(`drop database "${slot.name}" with (force)`) }
          catch (error) { cleanupError ??= error }
        }
      }
    } finally {
      await admin.end()
      if (!active.size) rmSync(tempRoot, { recursive: true, force: true })
      console.log(`[integration] files: ${passed} passed, ${failed} failed, ${skipped} skipped; cases: ${cases.passed} passed, ${cases.failed} failed, ${cases.skipped} skipped${unreported ? `; ${unreported} files without case totals` : ''}${diagnostic ? '; partial run is not full-suite proof' : ''}.`)
      if (retest.passed || retest.failed || retest.skipped) console.log(`[integration] retest files: ${retest.passed} passed, ${retest.failed} failed, ${retest.skipped} skipped; first-pass failures still fail this run.`)
      if (failedFiles.length) console.error(`[integration] failed files: ${failedFiles.sort().join(', ')}`)
      process.exitCode = fullRunExitCode(failed, interrupted)
    }
    if (cleanupError) throw cleanupError
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(`[integration] ${error.message}`); process.exitCode = 1 })
}
