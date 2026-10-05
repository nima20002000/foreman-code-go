import assert from 'node:assert/strict'
import test from 'node:test'
import { nativeAcceptanceConfiguration } from './test-native-acceptance.mjs'

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
