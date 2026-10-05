import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'
import { adminDatabaseUrl } from './test-integration.mjs'
import { stopGroup } from './integration-process.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(new URL('../apps/api/package.json', import.meta.url))
const { Pool } = require('pg')

export async function withAcceptanceDatabase(run) {
  const database = `graphql_native_test_${randomUUID().replaceAll('-', '')}`
  const adminUrl = adminDatabaseUrl()
  const admin = new Pool({ connectionString: adminUrl, max: 1, connectionTimeoutMillis: 10_000 })
  let created = false
  try {
    await admin.query(`create database "${database}"`)
    created = true
    const url = new URL(adminUrl)
    url.pathname = `/${database}`
    console.log('[acceptance] Created invocation-owned native test database.')
    return await run(url.toString())
  } finally {
    try {
      if (created) {
        await admin.query(`drop database "${database}" with (force)`)
        console.log('[acceptance] Removed invocation-owned native test database.')
      }
    } finally { await admin.end() }
  }
}

async function runNativeAcceptance(databaseUrl) {
  const evidenceDirectory = join(root, '.logs', 'native-acceptance', new URL(databaseUrl).pathname.slice(1))
  console.log(`[acceptance] Native evidence: ${evidenceDirectory}`)
  const child = spawn('corepack', ['pnpm', '--filter', '@graphql/api', 'test:acceptance'], {
    cwd: root, stdio: 'inherit', detached: true,
    env: { ...process.env, ENG03_A_TEST_DATABASE_URL: databaseUrl, ENG03_A_EVIDENCE_DIR: evidenceDirectory },
  })
  let interrupted
  let stopping
  let cleanupError
  const stop = signal => {
    interrupted = signal
    stopping ??= stopGroup(child.pid, { signal }).catch(error => { cleanupError = error })
  }
  const interrupt = () => stop('SIGINT')
  const terminate = () => stop('SIGTERM')
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', terminate)
  let code
  try {
    code = await new Promise((yes, no) => {
      child.once('error', no)
      child.once('exit', (status, signal) => yes(status ?? (signal === 'SIGINT' ? 130 : 143)))
    })
  } finally {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', terminate)
    await stopping
    await stopGroup(child.pid)
  }
  if (cleanupError) throw cleanupError
  if (interrupted === 'SIGINT') return 130
  if (interrupted) return 143
  return code
}

async function main() {
  const built = spawnSync('corepack', ['pnpm', '--filter', '@graphql/contracts', 'build'], {
    cwd: root, stdio: 'inherit',
  })
  if (built.status !== 0) throw new Error('Acceptance contracts build failed.')
  process.exitCode = await withAcceptanceDatabase(runNativeAcceptance)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(`[acceptance] ${error.message}`)
    process.exitCode = 1
  })
}
