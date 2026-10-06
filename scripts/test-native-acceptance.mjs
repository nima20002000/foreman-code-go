import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { delimiter, dirname, join, posix, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { adminDatabaseUrl, requireLoopbackTestDatabase } from './test-integration.mjs'
import { withNativeAcceptanceStorage } from './native-acceptance-storage.mjs'
import { stopGroup } from './integration-process.mjs'

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
    opencodeBinary: environment.ENG03_A_OPENCODE_BINARY ?? environment.OPENCODE_BINARY,
  }
}

export function nativeAcceptanceFiles(arguments_) {
  if (!arguments_.length) return [
    'test/eng03-c-native.acceptance.test.ts',
    'test/local-human-native.acceptance.test.ts',
    'test/local-human-native-recovery.acceptance.test.ts',
  ]
  if (arguments_[0] !== '--files' || arguments_.length < 2) {
    throw new Error('Use --files followed by explicit API acceptance test paths.')
  }
  const files = [...new Set(arguments_.slice(1).map(file =>
    file.startsWith('apps/api/') ? file.slice('apps/api/'.length) : file))]
  for (const file of files) {
    if (!/^test\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.acceptance\.test\.ts$/.test(file)
      || posix.normalize(file) !== file || !statSync(join(root, 'apps/api', file)).isFile()) {
      throw new Error(`Invalid acceptance test file: ${file}`)
    }
  }
  return files
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
  const name = `foreman_code_native_${randomUUID().replaceAll('-', '')}_test`
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
        if (callers.rows[0].count !== 0) {
          console.error('Task-owned acceptance database still had active callers during teardown.')
          record.exitCode = 1
        }
        await admin.query(`drop database "${name}" with (force)`)
        record.removed = true
      }
      await writeFile(join(evidence, 'database.json'), JSON.stringify(record, null, 2))
    } finally {
      await admin.end()
    }
  }
  return record
}

async function runNativeAcceptance(environment, files) {
  const child = spawn(process.execPath, [
    'scripts/heavy-job.mjs', '--', 'corepack', 'pnpm', '--filter', '@foreman-code/api', 'exec',
    'vitest', ...nativeAcceptanceVitestArguments(files, environment), '--maxWorkers=12',
  ], {
    cwd: root, stdio: 'inherit', detached: true,
    env: environment,
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
  const files = nativeAcceptanceFiles(process.argv.slice(2))
  const contracts = spawnSync('corepack', ['pnpm', '--filter', '@foreman-code/contracts', 'build'], {
    cwd: root, stdio: 'inherit',
  })
  if (contracts.status !== 0) {
    process.exitCode = contracts.status ?? 1
    return
  }
  const configuration = nativeAcceptanceConfiguration(process.env)
  const opencode = configuration.opencodeBinary ?? 'opencode'
  const record = await withNativeAcceptanceDatabase(configuration.databaseUrl,
    configuration.evidenceRoot, async ({ databaseUrl, evidence }) => {
      const environment = { ...nativeAcceptanceEnvironment(process.env),
        RUN_ENG03_C_NATIVE_TESTS: '1',
        RUN_REAL_HARNESS_TESTS: '1',
        ENG03_A_TEST_DATABASE_URL: databaseUrl,
        ENG03_A_OPENCODE_BINARY: opencode,
        ENG03_A_EVIDENCE_DIR: evidence,
        NIM2691_REAL_NATIVE: '1',
        NIM2691_POSTGRES: '1',
        NIM2691_ADMIN_DATABASE_URL: databaseUrl,
      }
      delete environment.TEST_DATABASE_URL
      console.log(`[acceptance] Native evidence: ${evidence}`)
      return withNativeAcceptanceStorage(environment, nativeEnvironment => runNativeAcceptance(nativeEnvironment, files))
    })
  process.exitCode = record.exitCode
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
