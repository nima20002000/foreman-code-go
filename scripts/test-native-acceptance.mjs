import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { delimiter, dirname, join, posix, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { assertTestPath, completeTestResourceCleanup, createFixtureDatabase, createFixtureSchema,
  dropFixtureDatabase, ownedTestDatabaseUrl, ownedTestPath, registerTestResourceCleanup,
  testAdminPool, testEnvironment } from './test-resources.mjs'
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
    if (!/^(?:test|src\/modules)\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.acceptance\.test\.ts$/.test(file)
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

async function pendingCleanup(invocation, ownId) {
  const folder = assertTestPath(invocation, join(invocation.directory, '.graphql-test-cleanup'))
  for (const name of await readdir(folder)) {
    const record = JSON.parse(await readFile(assertTestPath(invocation, join(folder, name)), 'utf8'))
    if (record.token !== invocation.token) throw new Error('Native acceptance cleanup ownership mismatch')
    if (record.id !== ownId && record.kind !== 'suite-process-group') return true
  }
  return false
}

export async function withNativeAcceptanceDatabase(configured, evidenceRoot, execute) {
  const parentUrl = ownedTestDatabaseUrl()
  if (configured !== undefined && configured !== parentUrl) throw new Error('Native acceptance requires its owned test database')
  ownedTestPath(evidenceRoot)
  const invocation = { directory: process.env.FOREMAN_CODE_TEST_ROOT, token: process.env.FOREMAN_CODE_TEST_OWNER }
  const admin = await testAdminPool()
  let resource
  let evidence
  let cleanupId
  const record = { name: null, created: false, exitCode: null, removed: false }
  try {
    const name = `foreman_code_native_${randomUUID().replaceAll('-', '')}_test`
    const parent = new Pool({ connectionString: parentUrl, max: 1 })
    try { await createFixtureDatabase(parent, name) } finally { await parent.end() }
    const database = new URL(parentUrl)
    database.pathname = `/${name}`
    resource = { ...invocation, name, databaseUrl: database.toString() }
    record.name = resource.name
    record.created = true
    cleanupId = registerTestResourceCleanup(invocation,
      { kind: 'native-acceptance-database', databaseUrl: resource.databaseUrl, name: resource.name })
    evidence = join(evidenceRoot, resource.name)
    await mkdir(evidence, { recursive: true, mode: 0o700 })
    const setup = new Pool({ connectionString: resource.databaseUrl, max: 1 })
    try {
      await createFixtureSchema(setup, 'native_acceptance')
      await setup.query(`alter database "${resource.name}" set search_path to native_acceptance`)
    } finally { await setup.end() }
    const environment = testEnvironment(process.env, resource)
    record.exitCode = await execute({ databaseUrl: resource.databaseUrl, evidence, environment })
  } finally {
    try {
      if (resource) {
        const callers = await admin.query('select count(*)::int as count from pg_stat_activity where datname=$1', [resource.name])
        if (callers.rows[0].count === 0 && !await pendingCleanup(invocation, cleanupId)) {
          const parent = new Pool({ connectionString: parentUrl, max: 1 })
          try { await dropFixtureDatabase(parent, resource.name) } finally { await parent.end() }
          completeTestResourceCleanup(invocation, cleanupId)
          record.removed = true
        } else {
          console.error('Owned acceptance database and recovery state retained because cleanup is unconfirmed.')
          record.exitCode = 1
        }
      }
      if (evidence) await writeFile(join(evidence, 'database.json'), JSON.stringify(record, null, 2), { mode: 0o600 })
    } finally { await admin.end() }
  }
  return record
}

async function runNativeAcceptance(environment, files) {
  const invocation = { directory: environment.FOREMAN_CODE_TEST_ROOT, token: environment.FOREMAN_CODE_TEST_OWNER }
  const cleanupId = registerTestResourceCleanup(invocation,
    { kind: 'native-acceptance-process-group', wrapperPid: process.pid, databaseUrl: environment.TEST_DATABASE_URL })
  const child = spawn(process.execPath, [
    'scripts/heavy-job.mjs', '--', 'corepack', 'pnpm', '--filter', '@foreman-code/api', 'exec',
    'vitest', ...nativeAcceptanceVitestArguments(files, environment), '--maxWorkers=1',
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
    completeTestResourceCleanup(invocation, cleanupId)
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
  const opencode = configuration.opencodeBinary ?? process.env.OPENCODE_BINARY ?? 'opencode'
  const record = await withNativeAcceptanceDatabase(configuration.databaseUrl,
    configuration.evidenceRoot, async ({ environment: isolated, evidence }) => {
      const environment = nativeAcceptanceEnvironment(isolated)
      console.log(`[acceptance] Native evidence: ${evidence}`)
      return runNativeAcceptance({ ...environment, RUN_ENG03_C_NATIVE_TESTS: '1',
        RUN_REAL_HARNESS_TESTS: '1', NIM2691_REAL_NATIVE: '1', NIM2691_POSTGRES: '1',
        ENG03_A_OPENCODE_BINARY: opencode }, files)
    })
  process.exitCode = record.exitCode
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
