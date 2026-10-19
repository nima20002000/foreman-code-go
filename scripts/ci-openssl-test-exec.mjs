import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { constants } from 'node:os'
import { basename, join } from 'node:path'
import { isolatedOpenSSLEnvironment, verifyOpenSSLInstallation, verifyOpenSSLTestLoader } from './ci-openssl-binding.mjs'
import { writeJsonReport } from './ci-report-io.mjs'

// This fixed go test -exec adapter receives the binary Go just built. It is not
// a request/MCP command hook, and never turns its prerequisite probe into tests.
async function run() {
  const current = verifyOpenSSLInstallation()
  const prerequisite = JSON.parse(readFileSync(join(current.state, 'prerequisite.json'), 'utf8'))
  if (prerequisite.cacheKey !== current.key || prerequisite.cgoEnabled !== '1'
    || prerequisite.scope !== 'prerequisite-only') {
    throw new Error('Actual OpenSSL test linkage requires this run\'s verified cgo prerequisite.')
  }
  if (!process.argv[2] || !basename(process.argv[2]).endsWith('.test')) {
    throw new Error('The selected OpenSSL test adapter requires an actual Go .test binary.')
  }
  const executable = realpathSync(process.argv[2])
  const binarySha256 = createHash('sha256').update(readFileSync(executable)).digest('hex')
  const invocation = mkdtempSync(join(current.state, 'test-'))
  const environment = isolatedOpenSSLEnvironment(process.env, current, invocation)
  environment.LD_DEBUG = 'files'
  environment.LD_DEBUG_OUTPUT = join(invocation, 'loader')
  const startedAt = new Date().toISOString()
  const child = spawn(executable, process.argv.slice(3), { env: environment, stdio: 'inherit' })
  const forward = signal => { if (child.exitCode === null && child.signalCode === null) child.kill(signal) }
  const interrupt = () => forward('SIGINT')
  const terminate = () => forward('SIGTERM')
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', terminate)
  let result
  try {
    result = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
  } finally {
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', terminate)
  }
  const nativeExit = result.code ?? 128 + (constants.signals[result.signal] ?? 1)
  let libraries = [], linkageError
  const tracePath = join(invocation, `loader.${child.pid}`)
  try {
    libraries = verifyOpenSSLTestLoader(current, readFileSync(tracePath, 'utf8'), executable)
  } catch (error) { linkageError = error.message }
  const actionExit = nativeExit || (linkageError ? 1 : 0)
  writeJsonReport(join(invocation, 'result.json'), { schemaVersion: 1, profile: 'openssl',
    version: current.pin.version, cacheKey: current.key, prefix: current.prefix,
    startedAt, finishedAt: new Date().toISOString(), executable, binarySha256, pid: child.pid,
    nativeExit, signal: result.signal, actionExit, linkageVerified: !linkageError,
    linkageError: linkageError ?? null, evidence: 'actual-test-process-glibc-loader', tracePath, libraries })
  if (linkageError) console.error(`[ci-openssl] ${linkageError}`)
  process.exitCode = actionExit
}

try { await run() }
catch (error) { console.error(error); process.exitCode = 1 }
