import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const prerequisites = fileURLToPath(new URL('./ci-go-prerequisites.mjs', import.meta.url))
const testDatabase = fileURLToPath(new URL('./test-db.mjs', import.meta.url))
const ownerLabel = 'foreman-code.go-ci-database'

function computer(t) {
  const directory = mkdtempSync(join(tmpdir(), 'ci-postgres-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const dockerState = join(directory, 'docker.json')
  const dockerCalls = join(directory, 'docker-calls.jsonl')
  const external = { Id: 'existing-installation', Name: 'existing-installation',
    Config: { Labels: {} }, State: { Running: true } }
  writeFileSync(dockerState, JSON.stringify({ nextPort: 45000, containers: [external], calls: [] }))
  writeFileSync(dockerCalls, '')
  writeFileSync(join(directory, 'docker'), `#!${process.execPath}
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
const state = JSON.parse(fs.readFileSync(process.env.DOCKER_STATE, 'utf8'))
fs.appendFileSync(process.env.DOCKER_CALLS, JSON.stringify(args) + '\\n')
const save = () => fs.writeFileSync(process.env.DOCKER_STATE, JSON.stringify(state))
const argument = name => args[args.indexOf(name) + 1]
save()
if (args[0] === 'run') {
  const label = argument('--label').split('=')
  const port = String(state.nextPort++)
  const container = { Id: 'container-' + port, Name: argument('--name'),
    Config: { Labels: { [label[0]]: label[1] } },
    Postgres: { user: process.env.POSTGRES_USER, database: process.env.POSTGRES_DB },
    State: { Running: true, Health: { Status: 'healthy' } },
    HostConfig: { NanoCpus: args.includes('--cpus') ? Number(argument('--cpus')) * 1e9 : 0,
      Memory: args.includes('--memory') ? Number(argument('--memory')) : 0 },
    NetworkSettings: { Ports: { '5432/tcp': [{
      HostIp: process.env.PUBLIC_BINDING === '1' ? '0.0.0.0' : '127.0.0.1', HostPort: port,
    }] } } }
  if (argument('--publish') !== '127.0.0.1::5432' || !args.includes('--rm')) {
    console.error('The fixture only supports ephemeral loopback PostgreSQL')
    process.exit(4)
  }
  state.containers.push(container)
  save()
  if (process.env.CANCEL_START === '1') {
    const profile = label[0].includes('scripts') ? 'scripts' : 'go'
    fs.writeFileSync(path.join(process.env.CI_STATE, profile + '-database-stop'), '')
  }
  if (process.env.FAIL_START === '1') {
    console.error('simulated PostgreSQL startup failure')
    process.exit(6)
  }
  console.log(container.Id)
} else if (args[0] === 'inspect') {
  const container = state.containers.find(value => value.Name === args[1])
  if (!container) { console.error('Error: No such object: ' + args[1]); process.exit(1) }
  console.log(JSON.stringify([container]))
} else if (args[0] === 'rm') {
  setTimeout(() => {
    state.containers = state.containers.filter(value => value.Id !== args.at(-1))
    save()
  }, Number(process.env.REMOVE_DELAY_MS ?? 0))
} else if (args[0] === 'exec') {
  if (process.env.FAIL_INITIALIZATION === '1') { console.error('simulated PostgreSQL initialization failure'); process.exit(7) }
  const container = state.containers.find(value => value.Name === args[args.indexOf('psql') - 1])
  if (!container || !fs.readFileSync(0, 'utf8').trim()) { console.error('database initialization needs its owned container and input'); process.exit(7) }
  container.initialized = true
  save()
} else {
  console.error('Unexpected Docker command: ' + args[0])
  process.exit(9)
}
`, { mode: 0o755 })
  const state = () => ({ ...JSON.parse(readFileSync(dockerState, 'utf8')),
    calls: readFileSync(dockerCalls, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) })
  function job({ host = false, profile = 'go', environment = {} } = {}) {
    const temporary = join(directory, randomUUID())
    mkdirSync(temporary)
    const env = { ...process.env, HOME: temporary, TMPDIR: temporary, PATH: `${directory}:${process.env.PATH}`,
      DOCKER_STATE: dockerState, DOCKER_CALLS: dockerCalls, CI_HOST_RUNNER: '', FOREMAN_CODE_CI_HOST_RUN_ID: '',
      FOREMAN_CODE_CI_DATABASE_STATE: temporary, FOREMAN_CODE_VERIFICATION_ENVIRONMENT: '',
      FOREMAN_CODE_CI_DATABASE_CPUS: '', FOREMAN_CODE_CI_DATABASE_MEMORY_BYTES: '',
      CI_STATE: join(temporary, 'foreman-ci-state'),
      DATABASE_URL: 'postgresql://unrelated.example/keep',
      GRAPHQL_CI_TEST_ADMIN_URL: 'postgresql://unrelated.example/keep', ...environment }
    if (host) {
      delete env.CI_STATE // Cancellation only supplies the host run's TMPDIR, as the real controller does.
      env.FOREMAN_CODE_CI_HOST_RUN_ID = randomUUID()
    }
    const run = (action, extra = {}) => {
      const result = spawnSync(process.execPath, [host ? testDatabase : prerequisites, action],
        { env: { ...env, ...extra }, encoding: 'utf8' })
      assert.ifError(result.error)
      return result
    }
    const prefix = profile === 'scripts' ? 'scripts-' : ''
    const runAsync = action => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [host ? testDatabase : prerequisites, action], { env })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', value => { stdout += value })
      child.stderr.on('data', value => { stderr += value })
      child.on('error', reject)
      child.on('close', status => resolve({ status, stdout, stderr }))
    })
    return { env, run, runAsync, start: () => run(host ? 'up' : `${prefix}database-start`),
      stop: () => run(host ? 'down' : `${prefix}database-stop`),
      url() {
        const environment = { ...env, CI_STATE: join(temporary, 'foreman-ci-state') }
        const result = spawnSync(process.execPath, [prerequisites, `${prefix}database-env`], { env: environment, encoding: 'utf8' })
        assert.ifError(result.error)
        assert.equal(result.status, 0, result.stderr)
        const variable = profile === 'scripts' ? 'FOREMAN_CODE_CI_TEST_ADMIN_URL' : 'DATABASE_URL'
        const url = new RegExp(`^export ${variable}='([^']+)'$`, 'm').exec(result.stdout)?.[1]
        assert.ok(url, 'The public environment command must export the isolated database URL')
        return new URL(url)
      } }
  }
  return { job, state, update: value => writeFileSync(dockerState, JSON.stringify(value)) }
}

test('Go CI runs use separate PostgreSQL ports and cleanup preserves other runs and installations', t => {
  const host = computer(t)
  const first = host.job()
  const second = host.job()
  assert.equal(first.start().status, 0)
  assert.equal(second.start().status, 0)
  const firstUrl = first.url()
  const secondUrl = second.url()
  assert.equal(firstUrl.hostname, '127.0.0.1')
  assert.notEqual(firstUrl.port, secondUrl.port)
  assert.notEqual(firstUrl.password, secondUrl.password)
  assert.equal(first.stop().status, 0)
  assert.equal(host.state().containers.length, 2)
  assert.equal(second.stop().status, 0)
  assert.deepEqual(host.state().containers.map(value => value.Id), ['existing-installation'])
  assert.equal(first.stop().status, 0)
})

test('host start and cancellation use the private run directory without a persistent compose server', t => {
  const host = computer(t)
  const first = host.job({ host: true })
  const second = host.job({ host: true })
  const started = first.start()
  assert.equal(started.status, 0, started.stderr)
  assert.equal(second.start().status, 0)
  assert.notEqual(first.url().port, second.url().port)
  assert.equal(first.stop().status, 0)
  assert.equal(second.stop().status, 0)
  assert.equal(host.state().calls.some(args => args[0] === 'compose'), false)
  assert.deepEqual(host.state().containers.map(value => value.Id), ['existing-installation'])
})

test('host cleanup for a unit job without a Go database is an idempotent no-op', t => {
  const host = computer(t)
  const job = host.job({ host: true })
  assert.equal(job.stop().status, 0)
  assert.equal(job.stop().status, 0)
  assert.deepEqual(host.state().calls, [])
})

for (const failure of ['FAIL_START', 'CANCEL_START', 'PUBLIC_BINDING']) {
  test(`PostgreSQL startup cleans its own container on ${failure.toLowerCase()}`, t => {
    const host = computer(t)
    const job = host.job({ environment: { [failure]: '1' } })
    const result = job.start()
    assert.notEqual(result.status, 0)
    assert.deepEqual(host.state().containers.map(value => value.Id), ['existing-installation'])
  })
}

test('cleanup before a delayed database starter prevents it from creating a server', t => {
  const host = computer(t)
  const job = host.job()
  assert.equal(job.stop().status, 0)
  assert.notEqual(job.start().status, 0)
  assert.deepEqual(host.state().calls, [])
})

test('cleanup refuses a container whose ownership changed', t => {
  const host = computer(t)
  const job = host.job()
  assert.equal(job.start().status, 0)
  const changed = host.state()
  changed.containers[1].Config.Labels[ownerLabel] = 'another-run'
  host.update(changed)
  const stopped = job.stop()
  assert.notEqual(stopped.status, 0)
  assert.match(stopped.stderr, /owned by another run/)
  assert.equal(host.state().containers.length, 2)
})

test('fresh PostgreSQL receives the database CPU and memory budget assigned by its host', t => {
  const host = computer(t)
  const job = host.job({ environment: {
    FOREMAN_CODE_CI_DATABASE_CPUS: '2.5', FOREMAN_CODE_CI_DATABASE_MEMORY_BYTES: String(2 ** 30),
  } })
  assert.equal(job.start().status, 0)
  const container = host.state().containers[1]
  assert.equal(container.HostConfig.NanoCpus, 2.5e9)
  assert.equal(container.HostConfig.Memory, 2 ** 30)
  assert.equal(job.stop().status, 0)
})

test('concurrent PostgreSQL cleanup calls remove the owned container exactly once', async t => {
  const host = computer(t)
  const job = host.job({ environment: { REMOVE_DELAY_MS: '500' } })
  const started = job.start()
  assert.equal(started.status, 0, started.stderr)
  const results = await Promise.all([job.runAsync('database-stop'), job.runAsync('database-stop')])
  for (const result of results) assert.equal(result.status, 0, result.stderr)
  assert.equal(host.state().calls.filter(args => args[0] === 'rm').length, 1)
  assert.deepEqual(host.state().containers.map(value => value.Id), ['existing-installation'])
})

test('retained scripts receive a fresh server that satisfies the existing disposable administrator URL guard', t => {
  const host = computer(t)
  const job = host.job({ profile: 'scripts', environment: {
    FOREMAN_CODE_DATABASE_URL: 'postgresql://unrelated.example/keep',
    FOREMAN_CODE_TEST_DATABASE_URL: 'postgresql://unrelated.example/keep',
    GRAPHQL_CI_HOST_RUN_ID: randomUUID(), PGSSLMODE: 'require',
  } })
  const started = job.start()
  assert.equal(started.status, 0, started.stderr)
  const environment = job.run('scripts-database-env')
  assert.equal(environment.status, 0, environment.stderr)
  const url = /^export FOREMAN_CODE_CI_TEST_ADMIN_URL='([^']+)'$/m.exec(environment.stdout)?.[1]
  const owner = /^export FOREMAN_CODE_CI_HOST_RUN_ID='([^']+)'$/m.exec(environment.stdout)?.[1]
  assert.ok(url)
  assert.match(owner, /^[0-9a-f-]{36}$/)
  const probeSource = `
    import { testAdminUrl, requireTestServerUrl } from ${JSON.stringify(new URL('./test-resources.mjs', import.meta.url).href)}
    const inheritedDatabaseVariables = ['DATABASE_URL', 'TEST_DATABASE_URL', 'FOREMAN_CODE_DATABASE_URL',
      'FOREMAN_CODE_TEST_DATABASE_URL', 'GRAPHQL_CI_TEST_ADMIN_URL', 'GRAPHQL_CI_HOST_RUN_ID', 'PGSSLMODE']
    console.log(JSON.stringify({ database: requireTestServerUrl(testAdminUrl).pathname,
      owner: process.env.FOREMAN_CODE_CI_HOST_RUN_ID,
      inherited: inheritedDatabaseVariables.filter(name => process.env[name] !== undefined) }))
  `
  const probe = spawnSync('/bin/bash', ['-c',
    'set -e; environment="$("$1" "$2" scripts-database-env)"; eval "$environment"; exec "$1" --input-type=module -e "$3"',
    'bash', process.execPath, prerequisites, probeSource], { encoding: 'utf8', env: job.env })
  assert.ifError(probe.error)
  assert.equal(probe.status, 0, probe.stderr)
  assert.deepEqual(JSON.parse(probe.stdout), { database: '/postgres', owner, inherited: [] })
  assert.equal(job.url().hostname, '127.0.0.1')
  assert.notEqual(job.url().port, '55439')
  const container = host.state().containers[1]
  assert.deepEqual(container.Postgres, { user: 'graphql_test_admin', database: 'graphql_test_control' })
  assert.equal(container.initialized, true)
  assert.equal(job.stop().status, 0)
  assert.deepEqual(host.state().containers.map(value => value.Id), ['existing-installation'])
})

test('retained script startup preserves a valid host run owner and refuses an invalid owner', t => {
  const host = computer(t)
  const owner = randomUUID()
  const job = host.job({ profile: 'scripts', environment: { FOREMAN_CODE_CI_HOST_RUN_ID: owner } })
  assert.equal(job.start().status, 0)
  const environment = job.run('scripts-database-env')
  assert.equal(environment.status, 0, environment.stderr)
  assert.equal(/^export FOREMAN_CODE_CI_HOST_RUN_ID='([^']+)'$/m.exec(environment.stdout)?.[1], owner)
  assert.equal(job.stop().status, 0)
  const invalid = host.job({ profile: 'scripts', environment: { FOREMAN_CODE_CI_HOST_RUN_ID: 'unrelated-owner' } })
  assert.notEqual(invalid.start().status, 0)
  assert.deepEqual(host.state().containers.map(value => value.Id), ['existing-installation'])
})

test('a retained script database initialization failure cleans only its own new server', t => {
  const host = computer(t)
  const go = host.job()
  assert.equal(go.start().status, 0)
  const scripts = host.job({ profile: 'scripts', environment: { FAIL_INITIALIZATION: '1' } })
  const failed = scripts.start()
  assert.notEqual(failed.status, 0)
  assert.match(failed.stderr, /initialization failure/)
  assert.equal(host.state().containers.length, 2)
  assert.equal(go.url().hostname, '127.0.0.1')
  assert.equal(go.stop().status, 0)
})

test('host cancellation cleans both owned database profiles and remains a no-op after they are gone', t => {
  const host = computer(t)
  const job = host.job({ environment: { FOREMAN_CODE_CI_HOST_RUN_ID: randomUUID() } })
  assert.equal(job.start().status, 0)
  const scripts = job.run('scripts-database-start')
  assert.equal(scripts.status, 0, scripts.stderr)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const stopped = spawnSync(process.execPath, [testDatabase, 'down'], { env: job.env, encoding: 'utf8' })
    assert.ifError(stopped.error)
    assert.equal(stopped.status, 0, stopped.stderr)
  }
  assert.equal(host.state().calls.filter(args => args[0] === 'rm').length, 2)
  assert.equal(host.state().calls.some(args => args[0] === 'compose'), false)
  assert.deepEqual(host.state().containers.map(value => value.Id), ['existing-installation'])
})
