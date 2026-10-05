import { spawn, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { adminDatabaseUrl, requireLoopbackTestDatabase } from './test-integration.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(new URL('../apps/api/package.json', import.meta.url))
const { Pool } = require('pg')

export function nativeAcceptanceEnvironment(source) {
  // Runtime-selection shims cannot reuse their home cache after diagnostics isolate HOME.
  const paths = [dirname(process.execPath), ...(source.PATH ?? '').split(delimiter)]
  return { ...source, PATH: [...new Set(paths.filter(Boolean))].join(delimiter) }
}

export function nativeAcceptanceConfiguration(environment) {
  return {
    databaseUrl: environment.ENG03_A_TEST_DATABASE_URL ?? environment.TEST_DATABASE_URL,
    evidenceRoot: environment.ENG03_A_EVIDENCE_DIR ?? join(root, '.logs', 'native-acceptance'),
    opencodeBinary: environment.ENG03_A_OPENCODE_BINARY,
  }
}

export function nativeAcceptanceFiles(args) {
  if (args.length === 0) return ['test/eng03-c-native.acceptance.test.ts']
  const [option, ...files] = args
  if (option !== '--files' || files.length === 0 || files.some((file) =>
    !/^test\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.acceptance\.test\.ts$/.test(file))) {
    throw new Error('Use --files followed by explicit API acceptance test paths.')
  }
  return [...new Set(files)]
}

export function nativeAcceptanceVitestArguments(files, environment) {
  const pattern = environment.ENG03_A_TEST_NAME_PATTERN
  return ['run', ...files, '--no-file-parallelism',
    ...(pattern ? ['--testNamePattern', pattern] : [])]
}

export async function withNativeAcceptanceDatabase(configured, evidenceRoot, execute) {
  if (configured) requireLoopbackTestDatabase(configured)
  const server = adminDatabaseUrl(configured)
  const admin = new Pool({ connectionString: server, max: 1 })
  const name = `graphql_native_${randomUUID().replaceAll('-', '')}_test`
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
  const files = nativeAcceptanceFiles(process.argv.slice(2))
  const configuration = nativeAcceptanceConfiguration(process.env)
  const opencode = configuration.opencodeBinary ?? execFileSync('which', ['opencode'], { encoding: 'utf8' }).trim()
  const record = await withNativeAcceptanceDatabase(configuration.databaseUrl,
    configuration.evidenceRoot, async ({ databaseUrl, evidence }) => {
      const environment = { ...nativeAcceptanceEnvironment(process.env),
        RUN_ENG03_C_NATIVE_TESTS: '1',
        ENG03_A_TEST_DATABASE_URL: databaseUrl,
        ENG03_A_OPENCODE_BINARY: opencode,
        ENG03_A_EVIDENCE_DIR: evidence,
      }
      delete environment.TEST_DATABASE_URL
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [
          'scripts/heavy-job.mjs', '--', 'corepack', 'pnpm', '--filter', '@foreman-code/api', 'exec',
          'vitest', ...nativeAcceptanceVitestArguments(files, environment),
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
