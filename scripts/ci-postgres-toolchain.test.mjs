import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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

function downloadFixture(t, { primary = 'unavailable', fallback = 'valid', patchRequired = false } = {}) {
  const fixture = temporaryFixture(t)
  const { directory, commands, env } = fixture
  const fixtureScript = join(directory, 'scripts/ci-postgres-toolchain.sh')
  const pins = {}
  const downloads = {}
  const calls = join(directory, 'downloads.jsonl')
  mkdirSync(dirname(fixtureScript))
  copyFileSync(script, fixtureScript)
  copyFileSync(wrapper, join(dirname(fixtureScript), 'ci-postgres-tool-wrapper.sh'))
  writeFileSync(calls, '')
  for (const [name, version] of Object.entries({ m4: '1.4.20', bison: '3.8.2', flex: '2.6.4', postgresql: '17.6' })) {
    const source = join(directory, `${name}-fixture`)
    const archive = `${source}.tar.gz`
    executable(join(source, 'configure'), `
      const { readFileSync, writeFileSync } = require('node:fs')
      if (${name === 'm4' && patchRequired}
        && JSON.parse(readFileSync(require('node:path').join(__dirname, 'feature.json'), 'utf8')).enabled !== true) {
        throw new Error('Fixture source compatibility patch is required')
      }
      const prefix = process.argv.slice(2).find(value => value.startsWith('--prefix=')).slice(9)
      writeFileSync('.fixture-build.json', JSON.stringify({ name: ${JSON.stringify(name)}, prefix }))
    `)
    writeFileSync(join(source, 'feature.json'), '{"enabled":false}\n')
    const packed = run('tar', ['--create', '--gzip', '--file', archive, '--directory', directory, `${name}-fixture`], env)
    assert.equal(packed.status, 0, packed.stderr)
    const url = `https://primary.example.invalid/${name}-${version}.tar.gz`
    const mirror = `https://mirror.example.invalid/${name}-${version}.tar.gz`
    const content = readFileSync(archive)
    pins[name] = { version, released: '2025-01-01', url,
      fallbackUrls: [mirror], sha256: createHash('sha256').update(content).digest('hex') }
    if (name === 'flex') pins[name].sha1 = createHash('sha1').update(content).digest('hex')
    downloads[url] = { archive, outcome: name === 'm4' ? primary : 'valid' }
    downloads[mirror] = { archive, outcome: name === 'm4' ? fallback : 'valid' }
  }
  writeFileSync(join(dirname(fixtureScript), 'ci-postgres-versions.json'), JSON.stringify(pins))
  executable(join(commands, 'curl'), `
    const { appendFileSync, copyFileSync, writeFileSync } = require('node:fs')
    const args = process.argv.slice(2)
    const url = args.at(-1)
    const output = args[args.indexOf('--output') + 1]
    appendFileSync(${JSON.stringify(calls)}, JSON.stringify(url) + '\\n')
    const download = ${JSON.stringify(downloads)}[url]
    if (!download) throw new Error('Unexpected download: ' + url)
    if (download.outcome === 'unavailable') {
      writeFileSync(output, 'partial failed transfer')
      process.exit(7)
    }
    if (download.outcome === 'corrupt') writeFileSync(output, 'corrupt completed transfer')
    else copyFileSync(download.archive, output)
  `)
  executable(join(commands, 'make'), `
    const { readFileSync, mkdirSync, writeFileSync } = require('node:fs')
    const { join } = require('node:path')
    if (!process.argv.includes('install')) process.exit(0)
    const { name, prefix } = JSON.parse(readFileSync('.fixture-build.json', 'utf8'))
    mkdirSync(join(prefix, 'bin'), { recursive: true })
    const tools = name === 'postgresql' ? ${JSON.stringify(requiredTools)} : [name]
    for (const tool of tools) {
      const body = '#!' + ${JSON.stringify(process.execPath)} + '\\nconsole.log('
        + JSON.stringify(tool + ' (PostgreSQL) 17.6') + ')\\n'
      writeFileSync(join(prefix, 'bin', tool), body, { mode: 0o755 })
    }
  `)
  return { ...fixture, script: fixtureScript, pins,
    downloads: () => readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
    temporaryInstalls: () => existsSync(env.FOREMAN_CODE_CI_POSTGRES_CACHE)
      ? readdirSync(env.FOREMAN_CODE_CI_POSTGRES_CACHE).filter(name => name.startsWith('install.')) : [],
  }
}

function fixtureSourcePatch(fixture, { result = 'true', preimage = 'false', declaredDigest } = {}) {
  const contents = `--- a/feature.json\n+++ b/feature.json\n@@ -1 +1 @@\n-{"enabled":${preimage}}\n+{"enabled":${result}}\n`
  const file = 'ci-postgres-patches/fixture.patch'
  const destination = join(dirname(fixture.script), file)
  mkdirSync(dirname(destination), { recursive: true })
  writeFileSync(destination, contents)
  fixture.pins.m4.patches = [{ file, sha256: declaredDigest ?? createHash('sha256').update(contents).digest('hex') }]
  writeFileSync(join(dirname(fixture.script), 'ci-postgres-versions.json'), JSON.stringify(fixture.pins))
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

test('PostgreSQL installation uses a checksum-verified source mirror after a failed primary transfer', t => {
  const fixture = downloadFixture(t)
  const installed = run('/bin/bash', [fixture.script, 'install'], fixture.env)
  assert.equal(installed.status, 0, installed.stderr)
  assert.deepEqual(fixture.downloads(), [fixture.pins.m4.url, ...fixture.pins.m4.fallbackUrls,
    fixture.pins.bison.url, fixture.pins.flex.url, fixture.pins.postgresql.url])
  const verified = run('/bin/bash', [fixture.script, 'verify'], fixture.env)
  assert.equal(verified.status, 0, verified.stderr)
  assert.deepEqual(fixture.temporaryInstalls(), [])
})

test('PostgreSQL installation stops and cleans temporary state when every source location is unreachable', t => {
  const fixture = downloadFixture(t, { fallback: 'unavailable' })
  const installed = run('/bin/bash', [fixture.script, 'install'], fixture.env)
  assert.notEqual(installed.status, 0)
  assert.match(installed.stderr, /All pinned download locations failed.*m4/)
  assert.deepEqual(fixture.downloads(), [fixture.pins.m4.url, ...fixture.pins.m4.fallbackUrls])
  assert.deepEqual(fixture.temporaryInstalls(), [])
  assert.notEqual(run('/bin/bash', [fixture.script, 'verify'], fixture.env).status, 0)
})

for (const primary of ['unavailable', 'corrupt']) {
  test(`PostgreSQL installation rejects a corrupt completed transfer after a ${primary} primary response`, t => {
    const fixture = downloadFixture(t, { primary, fallback: 'corrupt' })
    const installed = run('/bin/bash', [fixture.script, 'install'], fixture.env)
    assert.notEqual(installed.status, 0)
    assert.match(installed.stderr, /SHA-256 mismatch/)
    assert.deepEqual(fixture.downloads(), primary === 'corrupt'
      ? [fixture.pins.m4.url] : [fixture.pins.m4.url, ...fixture.pins.m4.fallbackUrls])
    assert.deepEqual(fixture.temporaryInstalls(), [])
    assert.notEqual(run('/bin/bash', [fixture.script, 'verify'], fixture.env).status, 0)
  })
}

test('PostgreSQL installation applies a verified source backport before configuring the pinned archive', t => {
  const fixture = downloadFixture(t, { patchRequired: true })
  const original = run('/bin/bash', [fixture.script, 'install'], fixture.env)
  assert.notEqual(original.status, 0)
  assert.match(original.stderr, /Fixture source compatibility patch is required/)
  fixtureSourcePatch(fixture)
  const patched = run('/bin/bash', [fixture.script, 'install'], fixture.env)
  assert.equal(patched.status, 0, patched.stderr)
  assert.equal(run('/bin/bash', [fixture.script, 'verify'], fixture.env).status, 0)
  assert.deepEqual(fixture.temporaryInstalls(), [])
})

test('PostgreSQL installation rejects a source backport whose digest differs before any download', t => {
  const fixture = downloadFixture(t, { patchRequired: true })
  fixtureSourcePatch(fixture, { declaredDigest: '0'.repeat(64) })
  const result = run('/bin/bash', [fixture.script, 'install'], fixture.env)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /SHA-256 mismatch for PostgreSQL build source patch/)
  assert.deepEqual(fixture.downloads(), [])
  assert.deepEqual(fixture.temporaryInstalls(), [])
})

test('PostgreSQL installation rejects a source backport that does not apply and cleans the failed extraction', t => {
  const fixture = downloadFixture(t, { patchRequired: true })
  fixtureSourcePatch(fixture, { preimage: '"different source"' })
  const result = run('/bin/bash', [fixture.script, 'install'], fixture.env)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Could not apply pinned PostgreSQL build source patch/)
  assert.deepEqual(fixture.temporaryInstalls(), [])
  assert.notEqual(run('/bin/bash', [fixture.script, 'verify'], fixture.env).status, 0)
})

test('PostgreSQL installation does not reuse a toolchain compiled with another source backport', t => {
  const fixture = downloadFixture(t, { patchRequired: true })
  fixtureSourcePatch(fixture)
  const original = run('/bin/bash', [fixture.script, 'install'], fixture.env)
  assert.equal(original.status, 0, original.stderr)
  fixtureSourcePatch(fixture, { result: '"incompatible"' })
  const changed = run('/bin/bash', [fixture.script, 'install'], fixture.env)
  assert.notEqual(changed.status, 0)
  assert.match(changed.stderr, /Fixture source compatibility patch is required/)
  assert.notEqual(run('/bin/bash', [fixture.script, 'verify'], fixture.env).status, 0)
  assert.deepEqual(fixture.temporaryInstalls(), [])
})
