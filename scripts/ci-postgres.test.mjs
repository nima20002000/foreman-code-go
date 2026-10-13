import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const script = fileURLToPath(new URL('./test-db.mjs', import.meta.url))

function computer(t, unavailable = false) {
  const parent = process.env.TMPDIR ?? join(homedir(), '.cache', 'foreman-tmp')
  mkdirSync(parent, { recursive: true })
  const directory = mkdtempSync(join(parent, 'ci-postgres-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const state = join(directory, 'servers.json')
  writeFileSync(state, '{}')
  writeFileSync(join(directory, 'docker'), `#!${process.execPath}
const fs = require('node:fs')
const args = process.argv.slice(2)
const servers = JSON.parse(fs.readFileSync(process.env.SERVERS, 'utf8'))
const project = args[args.indexOf('--project-name') + 1]
if (args[0] === 'ps') process.exit(0)
if (args[0] === 'volume') process.exit(0)
if (args.includes('up')) {
  if (process.env.UNAVAILABLE === '1' && !project.includes(process.env.FOREMAN_CODE_CI_HOST_RUN_ID)) {
    console.error('persistent server unavailable')
    process.exit(1)
  }
  servers[project] ??= 55000 + Object.keys(servers).length
  fs.writeFileSync(process.env.SERVERS, JSON.stringify(servers))
}
if (args.includes('port')) console.log('127.0.0.1:' + servers[project])
if (args.includes('down')) {
  delete servers[project]
  fs.writeFileSync(process.env.SERVERS, JSON.stringify(servers))
}
`, { mode: 0o755 })
  function job() {
    const runId = randomUUID()
    const temporary = join(directory, runId)
    mkdirSync(temporary)
    const env = { ...process.env, PATH: `${directory}:${process.env.PATH}`, TMPDIR: temporary,
      CI_HOST_RUNNER: '1', FOREMAN_CODE_CI_HOST_RUN_ID: runId, FOREMAN_CODE_VERIFICATION_ENVIRONMENT: '',
      FOREMAN_CODE_CI_POSTGRES_CACHE: join(directory, 'cache'), SERVERS: state,
      UNAVAILABLE: unavailable ? '1' : '0' }
    return {
      runId,
      up() {
        const result = spawnSync(process.execPath, [script, 'up'], { env, encoding: 'utf8' })
        assert.equal(result.status, 0, result.stderr)
        return readFileSync(join(temporary, 'test-database-url'), 'utf8')
      },
      down() {
        const result = spawnSync(process.execPath, [script, 'down'], { env, encoding: 'utf8' })
        assert.equal(result.status, 0, result.stderr)
      },
    }
  }
  return { job, servers: () => JSON.parse(readFileSync(state, 'utf8')) }
}

test('CI parts reuse one persistent server and job cleanup leaves it running', t => {
  const host = computer(t)
  const first = host.job()
  const second = host.job()
  const url = first.up()
  first.down()
  assert.equal(Object.keys(host.servers()).length, 1)
  assert.equal(second.up(), url)
  second.down()
  assert.equal(Object.keys(host.servers()).length, 1)
})

test('an unavailable persistent server falls back to separate job servers and cleans them up', t => {
  const host = computer(t, true)
  const first = host.job()
  const second = host.job()
  assert.notEqual(first.up(), second.up())
  assert.equal(Object.keys(host.servers()).length, 2)
  first.down()
  assert.equal(Object.keys(host.servers()).length, 1)
  second.down()
  assert.equal(Object.keys(host.servers()).length, 0)
})
