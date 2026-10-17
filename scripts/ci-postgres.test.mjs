import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
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
  const external = { Id: 'existing-installation', Name: 'existing-installation',
    Config: { Labels: {} }, State: { Running: true } }
  writeFileSync(dockerState, JSON.stringify({ nextPort: 45000, containers: [external], calls: [] }))
  writeFileSync(join(directory, 'docker'), `#!${process.execPath}
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
const state = JSON.parse(fs.readFileSync(process.env.DOCKER_STATE, 'utf8'))
state.calls.push(args)
const save = () => fs.writeFileSync(process.env.DOCKER_STATE, JSON.stringify(state))
const argument = name => args[args.indexOf(name) + 1]
save()
if (args[0] === 'run') {
  const label = argument('--label').split('=')
  const port = String(state.nextPort++)
  const container = { Id: 'container-' + port, Name: argument('--name'),
    Config: { Labels: { [label[0]]: label[1] } },
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
    fs.writeFileSync(path.join(process.env.CI_STATE, 'go-database-stop'), '')
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
  state.containers = state.containers.filter(value => value.Id !== args.at(-1))
  save()
} else {
  console.error('Unexpected Docker command: ' + args[0])
  process.exit(9)
}
`, { mode: 0o755 })
  const state = () => JSON.parse(readFileSync(dockerState, 'utf8'))
  function job({ host = false, environment = {} } = {}) {
    const temporary = join(directory, randomUUID())
    mkdirSync(temporary)
    const env = { ...process.env, HOME: temporary, TMPDIR: temporary, PATH: directory,
      DOCKER_STATE: dockerState, CI_HOST_RUNNER: '', FOREMAN_CODE_CI_HOST_RUN_ID: '',
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
    return { env, run, start: () => run(host ? 'up' : 'database-start'),
      stop: () => run(host ? 'down' : 'database-stop'),
      url() {
        const environment = { ...env, CI_STATE: join(temporary, 'foreman-ci-state') }
        const result = spawnSync(process.execPath, [prerequisites, 'database-env'], { env: environment, encoding: 'utf8' })
        assert.ifError(result.error)
        assert.equal(result.status, 0, result.stderr)
        const url = /^export DATABASE_URL='([^']+)'$/m.exec(result.stdout)?.[1]
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
