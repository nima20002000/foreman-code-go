import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { BASE, assertOwned, environment, freePort, options, publicError } from './safety.mjs'

async function fixture(work) {
  const state = await mkdtemp(join(await realpath('/tmp'), 'eng07-'))
  const owner = randomUUID()
  await chmod(state, 0o700)
  await writeFile(join(state, 'owner.json'), JSON.stringify({ owner, base: BASE }), { mode: 0o600 })
  try { await work(state, owner) } finally { await rm(state, { recursive: true, force: true }) }
}
test('defaults are independent of ambient database and service configuration', () => {
  assert.deepEqual(options([]), { apiPort: 3307, webPort: 5307, smoke: false })
  assert.deepEqual(options(['--api-port', '3407', '--web-port', '5407', '--smoke']), { apiPort: 3407, webPort: 5407, smoke: true })
})
test('rejects reuse/reset/URL options and malformed, duplicate or conflicting ports', () => {
  for (const args of [
    ['--database-url', 'postgresql://somewhere/production'], ['--reset'], ['--state', '/tmp/existing'],
    ['--api-port', '5432', '--web-port', '5432'], ['--api-port', '0'], ['--api-port', '65536'],
    ['--web-port', '80'], ['--web-port', '1.5'], ['--api-port', '-9'], ['--api-port', '3307\n'],
    ['--api-port'], ['--smoke', '--smoke'], ['--api-port', '3307', '--api-port', '3308'],
    ['--codex-model', 'bad\nmodel'], ['--codex-model', '$(command)'],
  ]) assert.throws(() => options(args), undefined, JSON.stringify(args))
})
test('allowlist excludes ambient database, code injection, web secrets and rollout flags', () => {
  const forbidden = ['DATABASE_URL', 'PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'PGOPTIONS',
    'PGSERVICE', 'PGSERVICEFILE', 'PGPASSFILE', 'PGDATA', 'NODE_OPTIONS', 'GRAPHQL_API_ENV_FILE',
    'GRAPHQL_OPENCODE_PARITY_QUALIFIED', 'GRAPHQL_ENABLE_EXPERIMENTAL_CODEX_APP_SERVER', 'VITE_PRIVATE_KEY',
    'HTTP_PROXY', 'HTTPS_PROXY', 'GRAPHQL_MCP_TOKEN', 'GRAPHQL_APP_MCP_TOKEN', 'GRAPHQL_OPERATOR_MCP_TOKEN']
  const input = Object.fromEntries(forbidden.map((key) => [key, 'forbidden-sentinel']))
  input.PATH = '/bin'; input.HOME = '/home/local'; input.OPENAI_API_KEY = 'test-only-provider-sentinel'
  const result = environment(input)
  assert.deepEqual(result, { PATH: '/bin', HOME: '/home/local', OPENAI_API_KEY: 'test-only-provider-sentinel' })
})
test('acceptance resources reject app URLs and socket overrides and own their native homes', async () => {
  const { createTestRoot, removeTestRoot, requireTestServerUrl, testAdminUrl, testEnvironment } = await import('../test-resources.mjs')
  const resource = createTestRoot()
  try {
    const url = new URL('/graphql_test_acceptance', testAdminUrl)
    assert.equal(requireTestServerUrl(url.href).port, '55439')
    for (const value of ['postgresql://graphql:graphql@127.0.0.1:5432/graphql',
      url.href + '?host=/tmp/app-socket', url.href + '?options=-c%20search_path=public']) {
      assert.throws(() => requireTestServerUrl(value), /dedicated disposable/)
    }
    const isolated = testEnvironment({ HOME: '/real/home', CODEX_HOME: '/real/codex' },
      { ...resource, name: 'graphql_test_acceptance', databaseUrl: url.href })
    const safe = environment(isolated)
    assert.equal(safe.HOME, join(resource.directory, 'home'))
    assert.equal(safe.CODEX_HOME, join(resource.directory, 'home/.codex'))
    assert.equal(safe.TEST_DATABASE_URL, url.href)
  } finally { removeTestRoot(resource) }
})
test('occupied ports are rejected without terminating or adopting the listener', async () => {
  const server = createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  try { await assert.rejects(freePort(port)); assert.equal(server.listening, true) }
  finally { await new Promise((resolve) => server.close(resolve)) }
  await freePort(port)
})
test('state identity and ownership marker are checked before any removal', async () => {
  await fixture(async (state, owner) => {
    await assertOwned(state, owner)
    await assert.rejects(assertOwned(state, 'not-the-owner'))
    assert.equal(JSON.parse(await readFile(join(state, 'owner.json'), 'utf8')).owner, owner)
    await writeFile(join(state, 'owner.json'), JSON.stringify({ owner, base: 'wrong-base' }))
    await assert.rejects(assertOwned(state, owner))
  })
})
test('outside paths, world-accessible state and symlink state are refused', async () => {
  await assert.rejects(assertOwned('/', 'x')); await assert.rejects(assertOwned('/tmp', 'x'))
  await fixture(async (state, owner) => {
    await chmod(state, 0o755); await assert.rejects(assertOwned(state, owner)); await chmod(state, 0o700)
    await fixture(async (other) => {
      const link = join(other, 'link')
      await symlink(state, link); await assert.rejects(assertOwned(link, owner))
    })
  })
})
test('error output uses safe codes, never exception messages or stack traces', () => {
  assert.equal(publicError(new Error('postgresql://name:test-only-sentinel@host/database')), 'ACCEPTANCE_STEP_FAILED')
  assert.equal(publicError({ code: 'secret with spaces', message: 'test-only-sentinel' }), 'ACCEPTANCE_STEP_FAILED')
  assert.equal(publicError({ code: 'ACCESS_DENIED' }), 'ACCESS_DENIED')
})
test('--help is dependency-free and does not create a task cluster', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./local.mjs', import.meta.url)), '--help'], { encoding: 'utf8' })
  assert.equal(result.status, 0); assert.match(result.stdout, /No database URL/); assert.equal(result.stderr, '')
})
test('invalid CLI input exits nonzero without exposing its value', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./local.mjs', import.meta.url)), '--database-url', 'test-only-sensitive-value'], { encoding: 'utf8' })
  assert.equal(result.status, 1); assert.doesNotMatch(result.stdout + result.stderr, /test-only-sensitive-value/)
})
