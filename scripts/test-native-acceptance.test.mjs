import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { nativeAcceptanceConfiguration, nativeAcceptanceEnvironment, nativeAcceptanceFiles,
  nativeAcceptanceOpenCodeBinary, nativeAcceptanceVitestArguments } from './test-native-acceptance.mjs'

test('native launchers retain the running Node interpreter when HOME is isolated', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-acceptance-runtime-'))
  const launcher = join(directory, 'launcher')
  try {
    await writeFile(join(directory, 'node'), '#!/bin/sh\nexit 81\n', { mode: 0o700 })
    const program = [
      '#!/usr/bin/env node',
      'console.log(JSON.stringify({runtime:process.execPath,home:process.env.HOME,',
      'credential:process.env.NATIVE_TEST_CREDENTIAL}))',
      '',
    ].join('\n')
    await writeFile(launcher, program, { mode: 0o700 })
    const source = { ...process.env, PATH: [directory, process.env.PATH].join(delimiter),
      HOME: directory, NATIVE_TEST_CREDENTIAL: 'fixture-credential' }
    const original = { ...source }
    const environment = nativeAcceptanceEnvironment(source)
    const output = execFileSync(launcher, { env: environment, encoding: 'utf8', timeout: 5_000 })
    assert.deepEqual(JSON.parse(output), {
      runtime: process.execPath, home: directory, credential: 'fixture-credential',
    })
    assert.deepEqual(source, original)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('acceptance keeps its caller-selected database, evidence and pinned binary', () => {
  const environment = {
    TEST_DATABASE_URL: 'postgresql://fixture@127.0.0.1:5432/general_test',
    ENG03_A_TEST_DATABASE_URL: 'postgresql://fixture@127.0.0.1:5432/native_test',
    ENG03_A_EVIDENCE_DIR: '/tmp/retained-native-evidence',
    ENG03_A_OPENCODE_BINARY: '/opt/pinned-opencode/opencode',
  }
  const original = { ...environment }
  assert.deepEqual(nativeAcceptanceConfiguration(environment), {
    databaseUrl: environment.ENG03_A_TEST_DATABASE_URL,
    evidenceRoot: environment.ENG03_A_EVIDENCE_DIR,
    opencodeBinary: environment.ENG03_A_OPENCODE_BINARY,
  })
  assert.deepEqual(environment, original)
})

test('acceptance retains the general test database fallback when no native database is selected', () => {
  const environment = { TEST_DATABASE_URL: 'postgresql://fixture@127.0.0.1:5432/general_test' }
  const configuration = nativeAcceptanceConfiguration(environment)
  assert.equal(configuration.databaseUrl, environment.TEST_DATABASE_URL)
  assert.equal(configuration.opencodeBinary, undefined)
})

test('acceptance keeps executable lookup deferred and respects explicit provider paths', () => {
  assert.equal(nativeAcceptanceConfiguration({ PATH: '' }).opencodeBinary, undefined)
  assert.equal(nativeAcceptanceConfiguration({ OPENCODE_BINARY: '/installed/opencode' }).opencodeBinary,
    '/installed/opencode')
  assert.equal(nativeAcceptanceConfiguration({ OPENCODE_BINARY: '/installed/opencode',
    ENG03_A_OPENCODE_BINARY: '/qualified/opencode' }).opencodeBinary, '/qualified/opencode')
})

test('Codex-only acceptance does not require an unrelated OpenCode installation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-acceptance-discovery-'))
  try {
    await symlink('/usr/bin/which', join(directory, 'which'))
    const environment = { PATH: directory }
    assert.equal(nativeAcceptanceOpenCodeBinary(environment), undefined)
    assert.equal(nativeAcceptanceOpenCodeBinary({ ...environment,
      ENG03_A_OPENCODE_BINARY: '/approved/pinned/opencode' }), '/approved/pinned/opencode')
    assert.deepEqual(environment, { PATH: directory })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('the native gate includes local-human isolation and production recovery by default', () => {
  assert.deepEqual(nativeAcceptanceFiles([]), [
    'test/eng03-c-native.acceptance.test.ts',
    'test/local-human-native.acceptance.test.ts',
    'test/local-human-native-recovery.acceptance.test.ts',
  ])
})

test('an explicit native gate selects only its requested files', () => {
  const file = 'test/local-human-native-recovery.acceptance.test.ts'
  assert.deepEqual(nativeAcceptanceFiles(['--files', file, `apps/api/${file}`]), [file])
})

test('native selection rejects empty, unknown and non-acceptance inputs', () => {
  for (const arguments_ of [
    ['--files'], ['--start-at', 'test/local-human-native.acceptance.test.ts'],
    ['--files', 'apps/api/test/../test/local-human-native.acceptance.test.ts'],
    ['--files', 'apps/api/test/local-human.integration.test.ts'],
    ['--files', 'apps/api/test/missing.acceptance.test.ts'],
  ]) assert.throws(() => nativeAcceptanceFiles(arguments_))
})

test('acceptance selects explicit API qualification files', () => {
  const file = 'test/opencode-qualification.acceptance.test.ts'
  assert.deepEqual(nativeAcceptanceFiles(['--files', file, file]), [file])
})

test('acceptance runs a selected case and leaves the complete gate as its default', () => {
  const files = ['test/eng03-c-native.acceptance.test.ts']
  const pattern = 'E03-A01 isolates a native approval wait from its progressing sibling'
  assert.deepEqual(nativeAcceptanceVitestArguments(files, { ENG03_A_TEST_NAME_PATTERN: pattern }),
    ['run', ...files, '--no-file-parallelism', '--testNamePattern', pattern])
  assert.deepEqual(nativeAcceptanceVitestArguments(files, {}), ['run', ...files, '--no-file-parallelism'])
})

test('acceptance rejects empty selections, broad filters and paths outside API tests', () => {
  for (const args of [['--files'], ['--files', 'opencode'], ['--files', '../test/opencode.acceptance.test.ts'],
    ['--files', 'test/../opencode.acceptance.test.ts'], ['--testNamePattern', 'qualification']]) {
    assert.throws(() => nativeAcceptanceFiles(args))
  }
})

test('the root acceptance command forwards file selection and rejects invalid paths before native execution', () => {
  const result = spawnSync('corepack', ['pnpm', 'test:acceptance', '--files', '../outside.acceptance.test.ts'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 10_000,
  })
  assert.ifError(result.error)
  assert.notEqual(result.status, 0)
  assert.match(result.stdout + result.stderr, /Invalid acceptance test file:/)
})

test('physical transfer and provider cases are selected explicitly as acceptance suites', () => {
  const files = ['src/modules/byte-transfer/rsync.physical.acceptance.test.ts',
    'test/codex-app-server.live.acceptance.test.ts']
  assert.deepEqual(nativeAcceptanceFiles(['--files', ...files]), files)
})
