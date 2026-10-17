import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const script = fileURLToPath(new URL('./ci-postgres-toolchain.sh', import.meta.url))
const wrapper = fileURLToPath(new URL('./ci-postgres-tool-wrapper.sh', import.meta.url))
const requiredTools = ['initdb', 'postgres', 'pg_isready', 'psql', 'createdb', 'pg_ctl', 'pg_config', 'pg_dump', 'pg_restore']

function executable(path, body) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `#!${process.execPath}\n${body}\n`, { mode: 0o755 })
}

function run(program, arguments_, env) {
  const result = spawnSync(program, arguments_, { env, encoding: 'utf8' })
  assert.ifError(result.error)
  return result
}

function temporaryFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'ci-postgres-tools-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const commands = join(directory, 'commands')
  const home = join(directory, 'home')
  mkdirSync(commands)
  mkdirSync(home)
  const env = {
    HOME: home,
    TMPDIR: directory,
    PATH: `${commands}:${process.env.PATH}`,
    FOREMAN_CODE_CI_POSTGRES_CACHE: join(directory, 'cache'),
    FOREMAN_CODE_CI_CPU_COUNT: '1',
  }
  // The fixtures exercise the helper's public CLI without compiling or contacting any service.
  for (const name of ['cc', 'c++', 'perl', 'git', 'openssl', 'ss']) {
    executable(join(commands, name), "console.log('fixture prerequisite')")
  }
  return { directory, commands, env }
}

function binaryDirectory(env) {
  const result = run('/bin/bash', ['-c', 'source "$1"; ci_postgres_environment; printf "%s\\n" "$CONFORMANCE_POSTGRES_BIN_DIR"', 'bash', script], env)
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

function installWrapper(directory, name, body) {
  const destination = join(directory, 'bin', name)
  mkdirSync(dirname(destination), { recursive: true })
  // Copy the executable wrapper as a program; assertions only examine its execution behavior.
  copyFileSync(wrapper, destination)
  chmodSync(destination, 0o755)
  executable(join(directory, 'installation', 'bin', name), body)
  return destination
}

function cachedToolFixtures(env, { version = '17.6', omitted } = {}) {
  const directory = dirname(binaryDirectory(env))
  for (const tool of requiredTools) {
    if (tool === omitted) continue
    installWrapper(directory, tool, `console.log(${JSON.stringify(`${tool} (PostgreSQL) ${version}`)})`)
  }
}

test('a cached PostgreSQL wrapper executes the relocated program with its own library environment', t => {
  const { directory, env } = temporaryFixture(t)
  const original = join(directory, 'original cache')
  const relocated = join(directory, 'relocated cache')
  const library = join(original, 'installation', 'lib')
  mkdirSync(library, { recursive: true })
  writeFileSync(join(library, 'fixture-library'), 'cached library')
  installWrapper(original, 'psql', `
    const { readFileSync } = require('node:fs')
    const { join } = require('node:path')
    console.log(JSON.stringify({
      library: readFileSync(join(process.env.LD_LIBRARY_PATH, 'fixture-library'), 'utf8'),
      arguments: process.argv.slice(2),
      inheritedHome: process.env.HOME ?? null,
      inheritedDatabase: process.env.PGHOST ?? null,
    }))
  `)
  renameSync(original, relocated)
  const result = run(join(relocated, 'bin', 'psql'), ['two words', "a'b", '$value'], { PATH: env.PATH })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), {
    library: 'cached library', arguments: ['two words', "a'b", '$value'], inheritedHome: null, inheritedDatabase: null,
  })
})

for (const tool of ['bison', 'flex']) {
  test(`the relocated ${tool} wrapper uses the cached macro processor and data`, t => {
    const { directory, env } = temporaryFixture(t)
    const original = join(directory, 'original parser tools')
    const relocated = join(directory, 'relocated parser tools')
    const skeletons = join(original, 'installation', 'share', 'bison', 'skeletons')
    mkdirSync(skeletons, { recursive: true })
    writeFileSync(join(skeletons, 'yacc.c'), 'cached parser skeleton')
    executable(join(original, 'installation', 'bin', 'm4'), "console.log('cached macro processor')")
    installWrapper(original, tool, `
      const { spawnSync } = require('node:child_process')
      const { readFileSync } = require('node:fs')
      const { join } = require('node:path')
      const macro = spawnSync(process.env.M4, [], { encoding: 'utf8' })
      if (macro.error) throw macro.error
      if (macro.status !== 0) throw new Error(macro.stderr)
      const skeleton = ${JSON.stringify(tool)} === 'bison'
        ? readFileSync(join(process.env.BISON_PKGDATADIR, 'skeletons', 'yacc.c'), 'utf8')
        : null
      console.log(JSON.stringify({ macro: macro.stdout.trim(), skeleton }))
    `)
    renameSync(original, relocated)
    const result = run(join(relocated, 'bin', tool), [], { PATH: env.PATH })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), {
      macro: 'cached macro processor', skeleton: tool === 'bison' ? 'cached parser skeleton' : null,
    })
  })
}

test('a missing compiler fails before preparing the PostgreSQL cache with an actionable instruction', t => {
  const { commands, env } = temporaryFixture(t)
  rmSync(join(commands, 'cc'))
  executable(join(commands, 'node'), "throw new Error('node must not run before the missing compiler is reported')")
  const result = run('/bin/bash', [script, 'environment'], { ...env, PATH: commands })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /requires cc in the existing build image/)
  assert.match(result.stderr, /does not install system packages on build computers/)
})

test('a complete cached PostgreSQL executable fixture is reused without invoking the downloader', t => {
  const { commands, env } = temporaryFixture(t)
  cachedToolFixtures(env)
  executable(join(commands, 'curl'), "throw new Error('a complete cache must not download archives')")
  const result = run('/bin/bash', [script, 'install'], env)
  assert.equal(result.status, 0, result.stderr)
})

test('cached PostgreSQL executables reporting a different version fail verification', t => {
  const { env } = temporaryFixture(t)
  cachedToolFixtures(env, { version: '17.5' })
  const result = run('/bin/bash', [script, 'verify'], env)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Expected PostgreSQL 17\.6/)
  assert.match(result.stderr, /17\.5/)
})

test('an incomplete cached PostgreSQL client tool set fails verification', t => {
  const { env } = temporaryFixture(t)
  cachedToolFixtures(env, { omitted: 'createdb' })
  const result = run('/bin/bash', [script, 'verify'], env)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /PostgreSQL createdb is missing/)
})

test('a mismatched PostgreSQL build archive fails before compilation and publishes no usable toolchain', t => {
  const { commands, env } = temporaryFixture(t)
  executable(join(commands, 'curl'), `
    const { writeFileSync } = require('node:fs')
    const output = process.argv[process.argv.indexOf('--output') + 1]
    writeFileSync(output, 'an archive whose checksum does not match the pinned release')
  `)
  executable(join(commands, 'make'), "throw new Error('compilation must not run for a mismatched archive')")
  const install = run('/bin/bash', [script, 'install'], env)
  assert.notEqual(install.status, 0)
  assert.match(install.stderr, /SHA-256 mismatch/)
  const verify = run('/bin/bash', [script, 'verify'], env)
  assert.notEqual(verify.status, 0)
  assert.match(verify.stderr, /Pinned PostgreSQL initdb is missing/)
})
