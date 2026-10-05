import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import test from 'node:test'
import { nativeAcceptanceConfiguration, nativeAcceptanceEnvironment, nativeAcceptanceFiles,
  nativeAcceptanceVitestArguments } from './test-native-acceptance.mjs'

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

test('acceptance selects explicit files and retains the default lifecycle gate', () => {
  const file = 'test/opencode-qualification.acceptance.test.ts'
  assert.deepEqual(nativeAcceptanceFiles([]), ['test/eng03-c-native.acceptance.test.ts'])
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
    assert.throws(() => nativeAcceptanceFiles(args), /explicit API acceptance test paths/)
  }
})

test('physical transfer and provider cases are selected explicitly as acceptance suites', () => {
  const files = ['src/modules/byte-transfer/rsync.physical.acceptance.test.ts',
    'test/codex-app-server.live.acceptance.test.ts']
  assert.deepEqual(nativeAcceptanceFiles(['--files', ...files]), files)
})
