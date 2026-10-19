import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { test } from 'node:test'
import { readAffectedRequest } from './ci-affected-scope.mjs'
import { nativeActionFixture } from './test-support/ci-native-action-fixture.mjs'
import { opensslFixture } from './test-support/ci-openssl-fixture.mjs'

// All compiler/Go/OpenSSL/loader processes below are synthetic external fixtures.
// The separate terminal R requests alone can qualify actual provider loading.
function assertIsolated(environment, fixture) {
  for (const name of ['OPENSSL_CONF', 'SSL_CERT_FILE', 'CTLOG_FILE']) {
    assert.equal(environment[name].startsWith(`${fixture.state}/go/openssl/`), true, name)
    assert.equal(readFileSync(environment[name], 'utf8'), '', name)
    assert.equal(statSync(environment[name]).mode & 0o777, 0o600, name)
  }
  assert.deepEqual(readdirSync(environment.SSL_CERT_DIR), [])
  assert.equal(environment.SSLKEYLOGFILE, undefined)
  assert.equal(environment.LD_PRELOAD, undefined)
  assert.equal(environment.LD_AUDIT, undefined)
  assert.equal(environment.NODE_OPTIONS, undefined)
  assert.equal(environment.LD_LIBRARY_PATH, join(environment.FOREMAN_CODE_CI_OPENSSL_PREFIX, 'lib'))
  assert.equal(environment.FOREMAN_TLS_OPENSSL, join(environment.FOREMAN_CODE_CI_OPENSSL_PREFIX, 'bin/openssl'))
  assert.equal(readFileSync(join(fixture.directory, 'foreign/keylog'), 'utf8'), 'untouched')
  assert.equal(readFileSync(join(fixture.home, 'existing-state'), 'utf8'), 'untouched')
}

function prepared(t) {
  const fixture = opensslFixture(t)
  const selected = fixture.seedInstallation()
  const result = fixture.run('verify')
  assert.equal(result.status, 0, result.stdout + result.stderr)
  return { fixture, selected }
}

test('the selected OpenSSL environment owns private configuration, stores and compiler bindings', t => {
  const fixture = opensslFixture(t)
  const selected = fixture.configured({ CI_STATE: 'state', FOREMAN_CODE_CI_OPENSSL_CACHE: 'cache' })
  assert.equal(selected.CI_STATE, fixture.state)
  assert.equal(selected.FOREMAN_CODE_CI_OPENSSL_CACHE, fixture.cache)
  assert.equal(selected.PKG_CONFIG_PATH, join(selected.FOREMAN_CODE_CI_OPENSSL_PREFIX, 'lib/pkgconfig'))
  for (const name of ['PKG_CONFIG_LIBDIR', 'PKG_CONFIG_SYSROOT_DIR', 'PKG_CONFIG_ALLOW_SYSTEM_CFLAGS']) {
    assert.equal(selected[name], undefined, name)
  }
  assert.equal(selected.CGO_CFLAGS, '-O2 -g')
  assert.equal(selected.CGO_LDFLAGS, '-O2 -g')
  assertIsolated(selected, fixture)
})

test('the public OpenSSL cache key binds resolved prefix, compiler and libc identity', t => {
  const fixture = opensslFixture(t)
  const key = overrides => {
    const result = fixture.run('cache-key', overrides)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    return result.stdout.trim()
  }
  const initial = key()
  assert.equal(key(), initial)
  assert.equal(key({ FOREMAN_CODE_CI_OPENSSL_CACHE: relative(fixture.directory, fixture.cache) }), initial)
  assert.notEqual(key({ FOREMAN_CODE_CI_OPENSSL_CACHE: join(fixture.directory, 'different-prefix') }), initial)
  assert.notEqual(key({ CI_OPENSSL_FIXTURE_COMPILER_VERSION: 'fixture cc 2' }), initial)
  assert.notEqual(key({ CI_OPENSSL_FIXTURE_LIBC: 'glibc 2.40' }), initial)
})

test('a cold OpenSSL download uses verified public transport and propagates failure with owned cleanup', t => {
  const fixture = opensslFixture(t)
  const result = fixture.run('install')
  assert.equal(result.status, 82, result.stdout + result.stderr)
  const downloads = fixture.calls().filter(call => call.tool === 'curl')
  assert.equal(downloads.length, 1)
  const download = downloads[0]
  assert.equal(download.args[0], '--disable')
  assert.equal(download.args.includes('--insecure') || download.args.includes('-k'), false)
  assert.equal(download.args[download.args.indexOf('--proto') + 1], '=https')
  assert.equal(download.args[download.args.indexOf('--proto-redir') + 1], '=https')
  assert.equal(download.args.at(-1), 'https://github.com/openssl/openssl/releases/download/openssl-3.5.7/openssl-3.5.7.tar.gz')
  for (const name of ['SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE', 'SSLKEYLOGFILE',
    'LD_LIBRARY_PATH', 'OPENSSL_MODULES', 'OPENSSL_ENGINES']) assert.equal(download.environment[name], undefined, name)
  assert.equal(readFileSync(download.environment.OPENSSL_CONF, 'utf8'), '')
  assert.deepEqual(fixture.calls().filter(call => ['tar', 'make', 'perl', 'binding'].includes(call.tool)), [])
  assert.equal(readdirSync(fixture.cache).some(name => name.startsWith('install.')), false)
  assert.equal(existsSync(join(fixture.state, 'go/openssl/prerequisite.json')), false)
  assert.equal(readFileSync(join(fixture.directory, 'foreign/keylog'), 'utf8'), 'untouched')
})

test('a recorded warm OpenSSL installation is reused without a source download or rebuild', t => {
  const fixture = opensslFixture(t)
  const selected = fixture.seedInstallation()
  const result = fixture.run('install')
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(fixture.calls().some(call => ['curl', 'tar', 'make', 'perl'].includes(call.tool)), false)
  assert.equal(existsSync(join(selected.FOREMAN_CODE_CI_OPENSSL_PREFIX, 'installation.json')), true)
  assert.equal(existsSync(join(fixture.state, 'go/openssl/prerequisite.json')), false,
    'A reused installation is preparation, not an executed native test or binding probe.')
})

test('a changed cached development input is rejected without silently rebuilding or qualifying it', t => {
  const fixture = opensslFixture(t)
  const selected = fixture.seedInstallation()
  writeFileSync(join(selected.FOREMAN_CODE_CI_OPENSSL_PREFIX, 'include/openssl/ssl.h'), 'changed external development fixture\n')
  const result = fixture.run('install')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /cached OpenSSL installation does not match/)
  assert.equal(fixture.calls().some(call => ['curl', 'binding'].includes(call.tool)), false)
  assert.equal(existsSync(join(fixture.state, 'go/openssl/prerequisite.json')), false)
})

test('an actual Go CGO-disabled response stops the selected provider prerequisite without qualification', t => {
  const fixture = opensslFixture(t)
  fixture.seedInstallation()
  const result = fixture.run('verify', { CI_OPENSSL_FIXTURE_CGO: '0' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /actual CGO_ENABLED must be 1/)
  assert.equal(fixture.calls().some(call => call.tool === 'binding' || call.tool === 'cc' && call.args.includes('-o')), false)
  assert.equal(existsSync(join(fixture.state, 'go/openssl/prerequisite.json')), false)
})

test('a selected compiler and binding process publish prerequisite evidence with zero native test count', t => {
  const { fixture, selected } = prepared(t)
  const receipt = fixture.prerequisite()
  assert.equal(receipt.scope, 'prerequisite-only')
  assert.equal(receipt.nativeTestCount, 0)
  assert.equal(receipt.cgoEnabled, '1')
  assert.equal(receipt.version, '3.5.7')
  assert.equal(receipt.binding.headerVersion, '3.5.7')
  assert.equal(receipt.binding.runtimeVersion, 'OpenSSL 3.5.7 9 Jun 2026')
  assert.equal(receipt.binding.cryptoPath, join(selected.FOREMAN_CODE_CI_OPENSSL_PREFIX, 'lib/libcrypto.so.3'))
  assert.equal(receipt.binding.sslPath, join(selected.FOREMAN_CODE_CI_OPENSSL_PREFIX, 'lib/libssl.so.3'))
  assert.equal(receipt.cliPath, join(selected.FOREMAN_CODE_CI_OPENSSL_PREFIX, 'bin/openssl'))
  assert.equal(receipt.cliVersion, 'OpenSSL 3.5.7 9 Jun 2026')
  const bindings = fixture.calls().filter(call => call.tool === 'binding')
  assert.equal(bindings.length, 1)
  assertIsolated(bindings[0].environment, fixture)
  const compiles = fixture.calls().filter(call => call.tool === 'cc' && call.args.includes('-o'))
  assert.equal(compiles.length, 1)
  assert.equal(compiles[0].args.includes(`-I${selected.FOREMAN_CODE_CI_OPENSSL_PREFIX}/include`), true)
  assert.equal(compiles[0].args.includes(`-L${selected.FOREMAN_CODE_CI_OPENSSL_PREFIX}/lib`), true)
  assert.equal(compiles[0].args.includes('-lssl') && compiles[0].args.includes('-lcrypto'), true)
  assert.deepEqual(receipt.compilation.arguments, compiles[0].args)
  assert.equal(receipt.compilation.scope, 'prerequisite-compile')
  assert.equal(receipt.compilation.nativeTestCount, 0)
  assert.equal(receipt.compilation.nativeExit, 0)
  assert.equal(receipt.compilation.actionExit, 0)
})

test('pkg-config preserves a spaced private prefix as exact compiler arguments', t => {
  const fixture = opensslFixture(t)
  const overrides = { FOREMAN_CODE_CI_OPENSSL_CACHE: join(fixture.directory, 'private cache') }
  const selected = fixture.seedInstallation(overrides)
  const result = fixture.run('verify', overrides)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const compilation = fixture.prerequisite().compilation
  assert.deepEqual(compilation.pkgConfig.cflags, [`-I${selected.FOREMAN_CODE_CI_OPENSSL_PREFIX}/include`])
  assert.deepEqual(compilation.pkgConfig.libraries, [`-L${selected.FOREMAN_CODE_CI_OPENSSL_PREFIX}/lib`, '-lssl', '-lcrypto'])
  const compiles = fixture.calls().filter(call => call.tool === 'cc' && call.args.includes('-o'))
  assert.equal(compiles.length, 1)
  assert.deepEqual(compilation.arguments, compiles[0].args)
})

test('a binding compiler failure retains its native exit and cleans its owned temporary output', t => {
  const fixture = opensslFixture(t)
  fixture.seedInstallation()
  const result = fixture.run('verify', { CI_OPENSSL_FIXTURE_COMPILER_EXIT: '29' })
  assert.equal(result.status, 1, result.stdout + result.stderr)
  const compilation = JSON.parse(readFileSync(join(fixture.state, 'go/openssl/binding-command.json'), 'utf8'))
  assert.equal(compilation.scope, 'prerequisite-compile')
  assert.equal(compilation.nativeTestCount, 0)
  assert.equal(compilation.nativeExit, 29)
  assert.equal(compilation.actionExit, 1)
  assert.equal(fixture.calls().some(call => call.tool === 'binding'), false)
  assert.equal(readdirSync(join(fixture.state, 'go/openssl')).some(name => name.startsWith('prerequisite.')), false)
  assert.equal(existsSync(join(fixture.state, 'go/openssl/prerequisite.json')), false)
})

test('a mismatching binding runtime cannot publish a prerequisite qualification receipt', t => {
  const fixture = opensslFixture(t)
  fixture.seedInstallation()
  const result = fixture.run('verify', { CI_OPENSSL_FIXTURE_RUNTIME_VERSION: '3.0.13' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /headers, runtime version and default-provider binding must match/)
  assert.equal(existsSync(join(fixture.state, 'go/openssl/prerequisite.json')), false)
})

for (const nativeExit of [0, 9]) {
  test(`the fixed OpenSSL test executor retains selected process output, loader receipt and native exit ${nativeExit}`, t => {
    const { fixture, selected } = prepared(t)
    const result = fixture.execute(selected, { CI_OPENSSL_FIXTURE_TEST_EXIT: String(nativeExit) })
    assert.equal(result.status, nativeExit, result.stdout + result.stderr)
    assert.match(result.stdout, /selected fixture stdout/)
    assert.match(result.stderr, /selected fixture stderr/)
    const receipts = fixture.invocations()
    assert.equal(receipts.length, 1)
    const receipt = receipts[0]
    assert.equal(receipt.nativeExit, nativeExit)
    assert.equal(receipt.actionExit, nativeExit)
    assert.equal(receipt.linkageVerified, true)
    assert.equal(receipt.evidence, 'actual-test-process-glibc-loader')
    assert.equal(receipt.tracePath.endsWith(`/loader.${receipt.pid}`), true)
    assert.deepEqual(receipt.libraries.map(value => value.name), ['libcrypto.so.3', 'libssl.so.3'])
    const calls = fixture.calls().filter(call => call.tool === 'test')
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].args, ['-test.run', '^TestSelected$'])
    assertIsolated(calls[0].environment, fixture)
  })
}

for (const loader of ['missing', 'wrong']) {
  test(`a ${loader} selected-process loader trace fails the action without inventing a failed native test`, t => {
    const { fixture, selected } = prepared(t)
    const result = fixture.execute(selected, { CI_OPENSSL_FIXTURE_LOADER_MODE: loader })
    assert.equal(result.status, 1, result.stdout + result.stderr)
    const receipts = fixture.invocations()
    assert.equal(receipts.length, 1)
    assert.equal(receipts[0].nativeExit, 0)
    assert.equal(receipts[0].actionExit, 1)
    assert.equal(receipts[0].linkageVerified, false)
    assert.equal(typeof receipts[0].linkageError, 'string')
    assert.deepEqual(receipts[0].libraries, [])
    assert.equal(Object.hasOwn(receipts[0], 'tests'), false)
  })
}

test('only the selected ordinary Go action activates its committed OpenSSL prerequisite profile', t => {
  const fixture = nativeActionFixture(t)
  const action = fixture.actions.find(value => value.kind === 'typecheck')
  fixture.put(action.selection, { files: [fixture.goFile], nativePrerequisites: ['openssl'] })
  const selected = fixture.cloud('unit-other', [action.selector], ['--openssl'])
  assert.equal(selected.status, 0, selected.stdout + selected.stderr)
  assert.equal(selected.stdout.trim(), 'true')
  for (const [suite, files] of [['unit-other', [fixture.ordinary]], ['typecheck-other', [action.selector]]]) {
    const result = fixture.cloud(suite, files, ['--openssl'])
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.equal(result.stdout.trim(), 'false')
  }
  const normalized = fixture.normalize('unit-other', [action.selector])
  assert.equal(normalized.status, 0, normalized.stdout + normalized.stderr)
  assert.deepEqual(normalized.request.nativeReports, {})
  assert.deepEqual(normalized.request.goTestRoots, {})
})

test('the committed OpenSSL profile admits exact Go files and rejects arbitrary prerequisite controls', t => {
  const fixture = nativeActionFixture(t)
  assert.deepEqual(readAffectedRequest({ files: [fixture.goFile], nativePrerequisites: ['openssl'] }, fixture.directory)
    .nativePrerequisites, ['openssl'])
  for (const nativePrerequisites of [['system-openssl'], ['openssl', 'openssl'], 'openssl', ['openssl', '-vet=off']]) {
    assert.throws(() => readAffectedRequest({ files: [fixture.goFile], nativePrerequisites }, fixture.directory), /prerequisites|OpenSSL profile/)
  }
  assert.throws(() => readAffectedRequest({ files: [fixture.ordinary], nativePrerequisites: ['openssl'] }, fixture.directory), /selected Go files/)
  assert.throws(() => readAffectedRequest({ files: [fixture.goFile], nativePrerequisites: ['openssl'], cgo: 0 }, fixture.directory), /bounded affected request/)
})
