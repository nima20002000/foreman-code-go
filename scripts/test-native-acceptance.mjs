import { spawn, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { adminDatabaseUrl, requireLoopbackTestDatabase } from './test-integration.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(new URL('../apps/api/package.json', import.meta.url))
const { Pool } = require('pg')

export async function withNativeAcceptanceDatabase(configured, evidenceRoot, execute) {
  if (configured) requireLoopbackTestDatabase(configured)
  const server = adminDatabaseUrl(configured)
  const admin = new Pool({ connectionString: server, max: 1 })
  const name = `graphql_native_test_${randomUUID().replaceAll('-', '')}`
  const evidence = join(evidenceRoot, name)
  const record = { name, created: false, exitCode: null, removed: false }
  await mkdir(evidence, { recursive: true, mode: 0o700 })
  try {
    await admin.query(`create database "${name}"`)
    record.created = true
    const database = new URL(server)
    database.pathname = `/${name}`
    record.exitCode = await execute({ databaseUrl: database.toString(), evidence })
  } finally {
    try {
      if (record.created) {
        const callers = await admin.query('select count(*)::int as count from pg_stat_activity where datname=$1', [name])
        if (callers.rows[0].count === 0) {
          await admin.query(`drop database "${name}"`)
          record.removed = true
        } else {
          console.error('Task-owned acceptance database retained because callers remain active.')
          record.exitCode = 1
        }
      }
      await writeFile(join(evidence, 'database.json'), JSON.stringify(record, null, 2))
    } finally {
      await admin.end()
    }
  }
  return record
}

async function main() {
  const opencode = execFileSync('which', ['opencode'], { encoding: 'utf8' }).trim()
  const record = await withNativeAcceptanceDatabase(process.env.TEST_DATABASE_URL,
    join(root, '.logs', 'native-acceptance'), async ({ databaseUrl, evidence }) => {
      const environment = { ...process.env,
        RUN_ENG03_C_NATIVE_TESTS: '1',
        ENG03_A_TEST_DATABASE_URL: databaseUrl,
        ENG03_A_OPENCODE_BINARY: opencode,
        ENG03_A_EVIDENCE_DIR: evidence,
      }
      delete environment.TEST_DATABASE_URL
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [
          'scripts/heavy-job.mjs', '--', 'corepack', 'pnpm', '--filter', '@graphql/api', 'exec',
          'vitest', 'run', 'test/eng03-c-native.acceptance.test.ts', '--no-file-parallelism',
        ], { cwd: root, env: environment, stdio: 'inherit' })
        child.once('error', reject)
        child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 143)))
      })
    })
  process.exitCode = record.exitCode
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
