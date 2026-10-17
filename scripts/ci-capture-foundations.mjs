import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'

const baseline = '8d2ea76c5028ef4458bf8cd64ef8624422e71d9f'
const baselineSnapshot = '51e85118bfcddef492cc4ecf555095ff09e6fe11'
const baselineTree = '0b8843295e54ed7830bbb276e782a8eff028b349'
const publicMirror = 'https://github.com/nima20002000/foreman-code-go-ci.git'
const repository = process.cwd()
const root = mkdtempSync(join(tmpdir(), 'foreman-schema-capture-'))
const source = join(root, 'source')
const containerName = `foreman-schema-capture-${randomUUID()}`
const containerLabel = 'foreman-code.schema-capture'
const captureId = randomUUID()
const disposablePassword = 'graphql_test_disposable_only'
let containerStarted = false
let sourceCreated = false
let server
let serverMessages = []

function command(label, program, args, options = {}) {
  console.log(`[capture] ${label}`)
  const result = spawnSync(program, args, { encoding: 'utf8', timeout: 600_000,
    maxBuffer: 64 * 1024 * 1024, ...options })
  if (result.error || result.status !== 0) {
    throw new Error(`${label} failed (exit ${result.status ?? result.error?.code ?? 'unknown'}). Private command output was withheld.`)
  }
  return result.stdout
}

function digest(bytes) { return createHash('sha256').update(bytes).digest('hex') }

function artifact(path, bytes) {
  bytes = Buffer.from(bytes)
  const encoded = gzipSync(bytes).toString('base64')
  const chunks = encoded.match(/.{1,6000}/g) ?? []
  console.log(`FOREMAN_CAPTURE ${JSON.stringify({ kind: 'artifact', path, bytes: bytes.length,
    sha256: digest(bytes), encoding: 'gzip+base64', chunks: chunks.length })}`)
  for (let index = 0; index < chunks.length; index++) {
    console.log(`FOREMAN_CAPTURE ${JSON.stringify({ kind: 'chunk', path, index, data: chunks[index] })}`)
  }
}

async function unusedPort() {
  const listener = createServer()
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const port = listener.address().port
  await new Promise((resolveClose, reject) => listener.close(error => error ? reject(error) : resolveClose()))
  return port
}

function isolatedEnvironment() {
  const environment = { PATH: process.env.PATH, COREPACK_HOME: process.env.COREPACK_HOME,
    CI: 'true', NODE_ENV: 'test', HOME: join(root, 'home'), LANG: 'C.UTF-8' }
  mkdirSync(environment.HOME, { recursive: true, mode: 0o700 })
  return environment
}

async function stopServer() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return
  const closed = once(server, 'exit')
  server.kill('SIGTERM')
  const stopped = await Promise.race([closed.then(() => true), delay(30_000).then(() => false)])
  if (!stopped) {
    server.kill('SIGKILL')
    await closed
    throw new Error('The owned TypeScript capture server required forced shutdown.')
  }
}

async function startDatabase(environment) {
  command('start owned disposable PostgreSQL', 'docker', ['run', '--detach', '--rm',
    '--name', containerName, '--label', `${containerLabel}=${captureId}`, '--publish', '127.0.0.1::5432',
    '--env', 'POSTGRES_USER=graphql_test_admin', '--env', 'POSTGRES_PASSWORD', '--env', 'POSTGRES_DB=postgres',
    'postgres:17.6-alpine', 'postgres', '-c', 'max_connections=300', '-c', 'max_locks_per_transaction=512'],
  { env: { ...environment, POSTGRES_PASSWORD: disposablePassword } })
  containerStarted = true
  const record = JSON.parse(command('inspect owned PostgreSQL', 'docker', ['inspect', containerName]))[0]
  if (record.Config.Labels[containerLabel] !== captureId) throw new Error('Capture container ownership changed.')
  const bindings = record.NetworkSettings.Ports['5432/tcp']
  if (bindings.length !== 1 || bindings[0].HostIp !== '127.0.0.1') throw new Error('Capture database is not isolated on loopback.')
  const adminUrl = `postgresql://graphql_test_admin:${disposablePassword}@127.0.0.1:${bindings[0].HostPort}/postgres`
  process.env.FOREMAN_CODE_CI_TEST_ADMIN_URL = adminUrl
  process.env.FOREMAN_CODE_CI_HOST_RUN_ID = captureId
  const require = createRequire(join(source, 'apps/api/package.json'))
  const { Client } = require('pg')
  for (let attempt = 0; attempt < 120; attempt++) {
    const client = new Client({ connectionString: adminUrl, connectionTimeoutMillis: 1000 })
    try {
      await client.connect()
      await client.query("comment on database postgres is 'graphql-disposable-test-server'")
      await client.end()
      return { Client, adminUrl }
    } catch (error) {
      await client.end()
      if (attempt === 119) throw new Error('Owned PostgreSQL did not become ready.', { cause: error })
      await delay(500)
    }
  }
}

async function waitUntilReady(url) {
  for (let attempt = 0; attempt < 360; attempt++) {
    if (server.exitCode !== null || server.signalCode !== null) {
      console.log(`[capture] server message labels: ${JSON.stringify(serverMessages)}`)
      throw new Error('The TypeScript baseline server exited before readiness.')
    }
    try {
      const response = await fetch(`${url}/health/ready`, { signal: AbortSignal.timeout(1000) })
      if (response.ok) return
    } catch { /* ignore: the owned server has not started listening yet. */ }
    await delay(500)
  }
  throw new Error('The TypeScript baseline server did not become ready within 180 seconds.')
}

async function inventory(client) {
  const tables = (await client.query("select schemaname,tablename from pg_tables where schemaname in ('public','langgraph') order by schemaname,tablename")).rows
  const counts = {}
  for (const { schemaname, tablename } of tables) {
    const identifier = value => `"${value.replaceAll('"', '""')}"`
    counts[`${schemaname}.${tablename}`] = Number((await client.query(
      `select count(*) as count from ${identifier(schemaname)}.${identifier(tablename)}`)).rows[0].count)
  }
  return counts
}

async function rejectCredentials(client, dump) {
  const columns = (await client.query("select table_schema,table_name,column_name from information_schema.columns where table_schema in ('public','langgraph') and column_name in ('token_hash','password','private_key','secret','access_token','refresh_token')")).rows
  for (const column of columns) {
    const quote = value => `"${value.replaceAll('"', '""')}"`
    const result = await client.query(`select count(*) as count from ${quote(column.table_schema)}.${quote(column.table_name)} where ${quote(column.column_name)} is not null`)
    if (Number(result.rows[0].count)) throw new Error(`Credential-bearing startup rows prevent safe capture (${column.table_schema}.${column.table_name}).`)
  }
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|Bearer [A-Za-z0-9._-]{12,}|postgresql:\/\/[^\s']+:[^\s']+@/.test(dump)) {
    throw new Error('The fresh SQL contains credential-like data; no SQL artifact was emitted.')
  }
}

function executableSql(raw) {
  const changes = { removedClientDirectives: [], removedPublicSchemaCreation: 0 }
  const lines = raw.split('\n').filter(line => {
    if (line.startsWith('\\')) {
      const directive = line.split(/\s/, 1)[0]
      if (!['\\restrict', '\\unrestrict'].includes(directive)) throw new Error(`Unexpected pg_dump client directive ${directive}.`)
      changes.removedClientDirectives.push(directive)
      return false
    }
    if (line === 'CREATE SCHEMA public;') { changes.removedPublicSchemaCreation++; return false }
    return true
  })
  return { sql: lines.join('\n'), changes }
}

async function captureSchema(environment) {
  const { Client } = await startDatabase(environment)
  const resources = await import(pathToFileURL(join(source, 'scripts/test-resources.mjs')))
  const owner = resources.createTestRoot(root)
  const admin = await resources.testAdminPool()
  let database, restored
  try {
    database = await resources.createTestDatabase(admin, owner)
    const apiEnvironment = resources.testEnvironment({ ...environment,
      FOREMAN_CODE_CI_TEST_ADMIN_URL: process.env.FOREMAN_CODE_CI_TEST_ADMIN_URL,
      FOREMAN_CODE_CI_HOST_RUN_ID: captureId }, database)
    const port = await unusedPort()
    Object.assign(apiEnvironment, { HOST: '127.0.0.1', PORT: String(port), FOREMAN_CODE_COMPUTER_UPKEEP: '0' })
    console.log('[capture] start actual pinned TypeScript server with fresh owned resources')
    server = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      cwd: join(source, 'apps/api'), env: apiEnvironment, stdio: ['ignore', 'pipe', 'ignore'] })
    let pending = ''
    server.stdout.on('data', chunk => {
      pending += chunk.toString()
      const lines = pending.split('\n')
      pending = lines.pop()
      for (const line of lines) {
        try {
          const message = JSON.parse(line)
          if (typeof message.msg === 'string' && /^[a-zA-Z0-9 .:;()_-]{1,180}$/.test(message.msg)) {
            serverMessages = [...serverMessages.slice(-9), message.msg]
          }
        } catch { /* ignore: only bounded structured message labels are safe diagnostics. */ }
      }
    })
    await waitUntilReady(`http://127.0.0.1:${port}`)
    await stopServer()
    const client = new Client({ connectionString: database.databaseUrl })
    await client.connect()
    let raw, before, migrations, serverVersion
    try {
      migrations = (await client.query('select version from application_migrations order by version')).rows.map(row => Number(row.version))
      const expected = JSON.parse(readFileSync(join(repository, 'backend/internal/schema/assets/expected-head.json'))).applicationMigrations
      if (JSON.stringify(migrations) !== JSON.stringify(expected)) throw new Error('Executed TS migration versions differ from the expected head.')
      before = await inventory(client)
      for (const table of ['checkpoints', 'checkpoint_blobs', 'checkpoint_writes']) {
        if (!Object.hasOwn(before, `langgraph.${table}`)) throw new Error(`Actual checkpoint table ${table} is missing.`)
      }
      serverVersion = (await client.query('show server_version')).rows[0].server_version
      raw = command('dump actual fresh TS schema and startup rows', 'docker', ['exec', '--env', 'PGPASSWORD', containerName,
        'pg_dump', '--username=graphql_test_admin', `--dbname=${database.name}`, '--format=plain', '--inserts',
        '--encoding=UTF8', '--no-owner', '--no-privileges'], { env: { ...environment, PGPASSWORD: disposablePassword } })
      await rejectCredentials(client, raw)
    } finally { await client.end() }
    const { sql, changes } = executableSql(raw)
    restored = await resources.createTestDatabase(admin, owner)
    const restoreClient = new Client({ connectionString: restored.databaseUrl })
    await restoreClient.connect()
    try {
      await restoreClient.query(sql)
      if (JSON.stringify(await inventory(restoreClient)) !== JSON.stringify(before)) throw new Error('Restored schema inventory or startup row counts differ.')
      const actual = (await restoreClient.query('select version from application_migrations order by version')).rows.map(row => Number(row.version))
      if (JSON.stringify(actual) !== JSON.stringify(migrations)) throw new Error('Restored migration history differs.')
    } finally { await restoreClient.end() }
    const provenance = { sourceCommit: baseline, sourceSnapshot: baselineSnapshot, verifiedSourceTree: baselineTree,
      captureExecutorCommit: command('read capture execution snapshot', 'git', ['rev-parse', 'HEAD']).trim(),
      capturedAt: new Date().toISOString(), rawSha256: digest(raw),
      sqlSha256: digest(sql), conversion: changes, checkpointSchema: 'langgraph', postgresServer: serverVersion,
      postgresClient: command('read dump client version', 'docker', ['exec', containerName, 'pg_dump', '--version']).trim(),
      node: process.version, pnpm: command('read pinned pnpm version', 'corepack', ['pnpm', '--version'], { cwd: source, env: environment }).trim(),
      migrations, rowCounts: before, verification: 'Actual TS startup; SQL restored with PostgreSQL driver on second fresh owned database; matching table and row inventories.' }
    artifact('backend/internal/schema/assets/baseline.sql', sql)
    artifact('backend/internal/schema/assets/capture-provenance.json', `${JSON.stringify(provenance, null, 2)}\n`)
    console.log(`[capture] verified ${migrations.length} actual migrations across ${Object.keys(before).length} tables`)
  } finally {
    await stopServer()
    if (restored) await resources.dropTestDatabase(admin, restored)
    if (database) await resources.dropTestDatabase(admin, database)
    await admin.end()
    resources.removeTestRoot(owner)
  }
}

async function main() {
  if (process.env.CI !== 'true' && process.env.CI !== '1') throw new Error('Foundation capture runs only inside authenticated Foreman CI.')
  if (process.argv[2] === '--download-diagnostics') {
    const pins = JSON.parse(readFileSync(join(repository, 'scripts/ci-go-versions.json')))
    const platform = process.arch === 'arm64' ? 'linux-arm64' : 'linux-amd64'
    const filename = `go${pins.go.version}.${platform}.tar.gz`
    for (const base of ['https://go.dev/dl/', 'https://dl.google.com/go/']) {
      const url = `${base}${filename}`
      const result = spawnSync('curl', ['--head', '--location', '--silent', '--show-error', '--max-time', '40',
        '--output', '/dev/null', '--write-out', '%{http_code} %{url_effective} %{num_redirects}', url],
      { encoding: 'utf8', timeout: 45_000 })
      console.log(`[capture] vendor-download ${JSON.stringify({ url, exit: result.status, result: result.stdout.trim() })}`)
    }
    return
  }
  const environment = isolatedEnvironment()
  if (process.argv[2] !== '--schema-only') {
    command('generate genuine pinned module checksums', 'go', ['mod', 'tidy'], {
      cwd: join(repository, 'backend'), env: { ...process.env, GOFLAGS: '-mod=mod' } })
    artifact('backend/go.mod', readFileSync(join(repository, 'backend/go.mod')))
    artifact('backend/go.sum', readFileSync(join(repository, 'backend/go.sum')))
  }
  command('fetch checked public TS baseline snapshot', 'git', ['fetch', '--quiet', '--no-tags', '--depth=1', publicMirror, baselineSnapshot])
  // Cloud snapshots retain source bytes without publishing the private source history.
  // The known baseline snapshot adds only CI durations; removing that one additive file
  // must reproduce the original complete tree, including every runtime import and manifest.
  const indexEnvironment = { ...process.env, GIT_INDEX_FILE: join(root, 'baseline.index') }
  command('load baseline source inventory', 'git', ['read-tree', baselineSnapshot], { env: indexEnvironment })
  command('exclude additive CI timing cache', 'git', ['update-index', '--force-remove', 'scripts/ci-learned-durations.json'], { env: indexEnvironment })
  const sourceTree = command('verify entire original baseline source tree', 'git', ['write-tree'], { env: indexEnvironment }).trim()
  if (sourceTree !== baselineTree) throw new Error('Public baseline snapshot does not reproduce the original complete source tree.')
  command('create pinned isolated TS source checkout', 'git', ['worktree', 'add', '--detach', source, baselineSnapshot])
  sourceCreated = true
  rmSync(join(source, 'scripts/ci-learned-durations.json'), { force: true })
  command('install exact baseline dependencies', 'corepack', ['pnpm', 'install', '--frozen-lockfile'], { cwd: source, env: environment })
  command('build exact baseline contracts', 'corepack', ['pnpm', '--filter', '@foreman-code/contracts', 'build'], { cwd: source, env: environment })
  await captureSchema(environment)
  console.log('FOREMAN_CAPTURE {"kind":"complete"}')
}

try { await main() }
catch (error) { console.error(`[capture] ${error.message}`); process.exitCode = 1 }
finally {
  try {
    await stopServer()
    if (containerStarted) {
      const record = JSON.parse(command('verify capture container cleanup ownership', 'docker', ['inspect', containerName]))[0]
      if (record.Config.Labels[containerLabel] !== captureId) throw new Error('Capture cleanup ownership changed.')
      command('remove owned capture PostgreSQL', 'docker', ['rm', '--force', '--volumes', containerName])
    }
    if (sourceCreated) command('remove owned baseline checkout', 'git', ['worktree', 'remove', '--force', source])
    command('prune finished baseline checkout registration', 'git', ['worktree', 'prune'])
    rmSync(root, { recursive: true, force: true })
  } catch (error) { console.error(`[capture] cleanup: ${error.message}`); process.exitCode = 1 }
}
