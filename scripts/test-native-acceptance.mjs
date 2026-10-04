import { spawn, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { adminDatabaseUrl, requireLoopbackTestDatabase } from './test-integration.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(new URL('../apps/api/package.json', import.meta.url))
const { Pool } = require('pg')

async function main() {
  const configured = process.env.TEST_DATABASE_URL
  if (configured) requireLoopbackTestDatabase(configured)
  const server = adminDatabaseUrl(configured)
  const admin = new Pool({ connectionString: server, max: 1 })
  const name = `graphql_native_test_${randomUUID().replaceAll('-', '')}`
  const evidence = join(root, '.logs', 'native-acceptance', name)
  const record = { name, created: false, exitCode: null, removed: false }
  await mkdir(evidence, { recursive: true, mode: 0o700 })
  try {
    const opencode = execFileSync('which', ['opencode'], { encoding: 'utf8' }).trim()
    await admin.query(`create database "${name}"`)
    record.created = true
    const database = new URL(server)
    database.pathname = `/${name}`
    const environment = { ...process.env,
      RUN_ENG03_C_NATIVE_TESTS: '1',
      ENG03_A_TEST_DATABASE_URL: database.toString(),
      ENG03_A_OPENCODE_BINARY: opencode,
      ENG03_A_EVIDENCE_DIR: evidence,
    }
    delete environment.TEST_DATABASE_URL
    record.exitCode = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        'scripts/heavy-job.mjs', '--', 'corepack', 'pnpm', '--filter', '@graphql/api', 'exec',
        'vitest', 'run', 'test/eng03-c-native.acceptance.test.ts', '--no-file-parallelism',
      ], { cwd: root, env: environment, stdio: 'inherit' })
      child.once('error', reject)
      child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 143)))
    })
    process.exitCode = record.exitCode
  } finally {
    try {
      if (record.created) {
        const callers = await admin.query('select count(*)::int as count from pg_stat_activity where datname=$1', [name])
        if (callers.rows[0].count === 0) {
          await admin.query(`drop database "${name}"`)
          record.removed = true
        } else {
          console.error('Task-owned acceptance database retained because callers remain active.')
          process.exitCode = 1
        }
      }
      await writeFile(join(evidence, 'database.json'), JSON.stringify(record, null, 2))
    } finally {
      await admin.end()
    }
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
