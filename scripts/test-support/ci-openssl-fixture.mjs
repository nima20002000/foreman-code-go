import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scripts = fileURLToPath(new URL('..', import.meta.url))
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`
const environmentNames = ['CI_STATE', 'FOREMAN_CODE_CI_OPENSSL_CACHE', 'FOREMAN_CODE_CI_OPENSSL_KEY',
  'FOREMAN_CODE_CI_OPENSSL_PREFIX', 'FOREMAN_CODE_CI_OPENSSL_IDENTITY', 'FOREMAN_TLS_OPENSSL',
  'CC', 'PKG_CONFIG', 'CGO_CFLAGS', 'CGO_CPPFLAGS', 'CGO_CXXFLAGS', 'CGO_LDFLAGS',
  'PKG_CONFIG_PATH', 'PKG_CONFIG_LIBDIR', 'PKG_CONFIG_SYSROOT_DIR', 'PKG_CONFIG_ALLOW_SYSTEM_CFLAGS',
  'OPENSSL_CONF', 'OPENSSL_CONF_INCLUDE', 'OPENSSL_MODULES', 'OPENSSL_ENGINES',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'SSLKEYLOGFILE', 'CURL_CA_BUNDLE', 'CTLOG_FILE', 'RANDFILE',
  'LD_LIBRARY_PATH', 'LD_PRELOAD', 'LD_AUDIT', 'NODE_OPTIONS']
const capture = `
fixture_capture() {
  local fixture_name
  for fixture_name in ${environmentNames.join(' ')}; do
    if [[ -v "$fixture_name" ]]; then
      printf '%s\\0%s\\0%s\\0' "$fixture_name" set "\${!fixture_name}"
    else
      printf '%s\\0%s\\0%s\\0' "$fixture_name" unset ''
    fi
  done
}
fixture_record() {
  local fixture_record_path="$CI_OPENSSL_FIXTURE_CALLS/$1.$BASHPID"
  shift
  printf '%s\\0' "$@" > "$fixture_record_path.args"
  fixture_capture > "$fixture_record_path.environment"
}
`

function decodeEnvironment(bytes) {
  const fields = bytes.split('\0')
  const environment = {}
  for (let index = 0; index + 2 < fields.length; index += 3) {
    if (fields[index + 1] === 'set') environment[fields[index]] = fields[index + 2]
  }
  return environment
}

/**
 * External compiler, Go, OpenSSL CLI and loader processes are explicit fixtures.
 * Their synthetic bytes/traces exercise the public prerequisite and -exec CLIs;
 * they provide no evidence that actual R code linked or loaded OpenSSL.
 */
export function opensslFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'ci-openssl-public-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const put = (path, contents, executable = false) => {
    const destination = join(directory, path)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, contents)
    if (executable) chmodSync(destination, 0o755)
    return destination
  }
  for (const name of ['ci-openssl-versions.json', 'ci-openssl-toolchain.sh', 'ci-openssl-binding.c',
    'ci-openssl-binding.mjs', 'ci-openssl-test-exec.mjs', 'ci-report-io.mjs']) {
    mkdirSync(join(directory, 'scripts'), { recursive: true })
    copyFileSync(join(scripts, name), join(directory, 'scripts', name))
  }
  const state = join(directory, 'state')
  const home = join(directory, 'home')
  const cache = join(directory, 'cache')
  const callsDirectory = join(directory, 'calls')
  mkdirSync(callsDirectory)
  mkdirSync(join(directory, 'foreign', 'certs'), { recursive: true })
  put('home/existing-state', 'untouched')
  put('foreign/openssl.cnf', '# fixture sentinel, never a real configuration\n')
  put('foreign/certs.pem', 'fixture sentinel, never a real certificate\n')
  put('foreign/keylog', 'untouched')

  // A host Node binary may itself dynamically link OpenSSL. Bootstrap it with
  // host libraries, then restore the exact caller environment before the public
  // script starts; the synthetic prefix contains deliberately non-ELF fixtures.
  const bootstrap = put('node-bootstrap.mjs', `
if (process.env.CI_OPENSSL_FIXTURE_LIBRARY_PATH_SET === '1') {
  process.env.LD_LIBRARY_PATH = process.env.CI_OPENSSL_FIXTURE_LIBRARY_PATH
} else delete process.env.LD_LIBRARY_PATH
delete process.env.CI_OPENSSL_FIXTURE_LIBRARY_PATH_SET
delete process.env.CI_OPENSSL_FIXTURE_LIBRARY_PATH
`)
  const node = put('bin/node', `#!/bin/bash
set -eu
if [[ -v LD_LIBRARY_PATH ]]; then
  export CI_OPENSSL_FIXTURE_LIBRARY_PATH_SET=1 CI_OPENSSL_FIXTURE_LIBRARY_PATH="$LD_LIBRARY_PATH"
else
  export CI_OPENSSL_FIXTURE_LIBRARY_PATH_SET=0
  unset CI_OPENSSL_FIXTURE_LIBRARY_PATH
fi
unset LD_LIBRARY_PATH
exec ${quote(process.execPath)} --import ${quote(bootstrap)} "$@"
`, true)
  const binding = put('binding-fixture', `#!/bin/bash
set -eu
${capture}
fixture_record binding "$@"
printf 'headerVersion=%s\n' "\${CI_OPENSSL_FIXTURE_HEADER_VERSION:-3.5.7}"
printf 'runtimeVersion=OpenSSL %s 9 Jun 2026\n' "\${CI_OPENSSL_FIXTURE_RUNTIME_VERSION:-3.5.7}"
printf 'cryptoPath=%s/lib/libcrypto.so.3\n' "$FOREMAN_CODE_CI_OPENSSL_PREFIX"
printf 'sslPath=%s/lib/libssl.so.3\n' "$FOREMAN_CODE_CI_OPENSSL_PREFIX"
printf 'provider=default\ncontext=created\n'
`, true)
  put('bin/cc', `#!/bin/bash
set -eu
${capture}
fixture_record cc "$@"
case "\${1:-}" in
  --version) printf '%s\n' "\${CI_OPENSSL_FIXTURE_COMPILER_VERSION:-fixture cc 1}"; exit 0 ;;
  -dumpmachine) printf 'x86_64-fixture-linux-gnu\n'; exit 0 ;;
esac
if [ "\${CI_OPENSSL_FIXTURE_COMPILER_EXIT:-0}" != 0 ]; then exit "$CI_OPENSSL_FIXTURE_COMPILER_EXIT"; fi
fixture_output=
while [ "$#" -gt 0 ]; do
  if [ "$1" = -o ]; then shift; fixture_output="$1"; fi
  shift
done
[ -n "$fixture_output" ] || exit 91
cp "$CI_OPENSSL_FIXTURE_BINDING" "$fixture_output"
chmod 755 "$fixture_output"
`, true)
  put('bin/pkg-config', `#!/bin/bash
set -eu
${capture}
fixture_record pkg-config "$@"
case "\${1:-}" in
  --version) printf '1.8.1\n' ;;
  --modversion) printf '3.5.7\n' ;;
  --variable=prefix) printf '%s\n' "$FOREMAN_CODE_CI_OPENSSL_PREFIX" ;;
  --variable=includedir) printf '%s/include\n' "$FOREMAN_CODE_CI_OPENSSL_PREFIX" ;;
  --variable=libdir) printf '%s/lib\n' "$FOREMAN_CODE_CI_OPENSSL_PREFIX" ;;
  --cflags) printf '%q\n' "-I$FOREMAN_CODE_CI_OPENSSL_PREFIX/include" ;;
  --libs) printf '%q ' "-L$FOREMAN_CODE_CI_OPENSSL_PREFIX/lib" -lssl -lcrypto; printf '\n' ;;
  *) exit 92 ;;
esac
`, true)
  put('bin/uname', '#!/bin/bash\ncase "$1" in -s) echo Linux ;; -m) echo x86_64 ;; *) exit 93 ;; esac\n', true)
  put('bin/getconf', '#!/bin/bash\nprintf "%s\\n" "${CI_OPENSSL_FIXTURE_LIBC:-glibc 2.39}"\n', true)
  put('bin/go', `#!/bin/bash
set -eu
${capture}
fixture_record go "$@"
[ "\${1:-}" = env ] || exit 94
case "\${2:-}" in
  CGO_ENABLED) printf '%s\n' "\${CI_OPENSSL_FIXTURE_CGO:-1}" ;;
  CC) printf '%s\n' "$CC" ;;
  *) exit 94 ;;
esac
`, true)
  put('bin/curl', `#!/bin/bash
set -eu
${capture}
fixture_record curl "$@"
exit 82
`, true)
  for (const command of ['tar', 'make', 'perl']) {
    put(`bin/${command}`, `#!/bin/bash\nset -eu\n${capture}\nfixture_record ${command} "$@"\nexit 95\n`, true)
  }
  const environment = { ...process.env, HOME: home, CI_STATE: state,
    PATH: `${join(directory, 'bin')}:${process.env.PATH}`, FOREMAN_CODE_CI_OPENSSL_CACHE: cache,
    CI_OPENSSL_FIXTURE_CALLS: callsDirectory, CI_OPENSSL_FIXTURE_BINDING: binding,
    OPENSSL_CONF: join(directory, 'foreign', 'openssl.cnf'), OPENSSL_CONF_INCLUDE: join(directory, 'foreign'),
    SSL_CERT_FILE: join(directory, 'foreign', 'certs.pem'), SSL_CERT_DIR: join(directory, 'foreign', 'certs'),
    SSLKEYLOGFILE: join(directory, 'foreign', 'keylog'), CURL_CA_BUNDLE: join(directory, 'foreign', 'certs.pem'),
    PKG_CONFIG_LIBDIR: join(directory, 'foreign'), PKG_CONFIG_SYSROOT_DIR: join(directory, 'foreign'),
    PKG_CONFIG_ALLOW_SYSTEM_CFLAGS: '1' }
  for (const name of ['NODE_OPTIONS', 'LD_PRELOAD', 'LD_AUDIT', 'LD_DEBUG', 'LD_DEBUG_OUTPUT', 'LD_LIBRARY_PATH', 'NODE_TEST_CONTEXT']) delete environment[name]
  const helper = join(directory, 'scripts', 'ci-openssl-toolchain.sh')
  function invoke(command, args, overrides = {}) {
    const result = spawnSync(command, args, { cwd: directory, env: { ...environment, ...overrides },
      encoding: 'utf8', timeout: 30_000 })
    assert.equal(result.error, undefined, 'The public CLI must launch before its behavior is asserted.')
    return result
  }
  function configured(overrides = {}) {
    const result = invoke('/bin/bash', ['-c', `set -e\n${capture}\nfixture_settings="$(/bin/bash "$1" environment)"\neval "$fixture_settings"\nfixture_capture`, '--', helper], overrides)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    const captured = decodeEnvironment(result.stdout)
    return { ...environment, ...overrides, ...captured,
      ...Object.fromEntries(environmentNames.filter(name => !Object.hasOwn(captured, name)).map(name => [name, undefined])) }
  }
  function seedInstallation(overrides = {}) {
    const selected = configured(overrides)
    const prefix = selected.FOREMAN_CODE_CI_OPENSSL_PREFIX
    for (const relative of ['include/openssl/opensslv.h', 'include/openssl/ssl.h',
      'lib/libcrypto.so.3', 'lib/libssl.so.3', 'lib/pkgconfig/openssl.pc', 'lib/pkgconfig/libcrypto.pc', 'lib/pkgconfig/libssl.pc']) {
      mkdirSync(dirname(join(prefix, relative)), { recursive: true })
      writeFileSync(join(prefix, relative), `synthetic prerequisite fixture: ${relative}\n`)
    }
    for (const name of ['libcrypto', 'libssl']) symlinkSync(`${name}.so.3`, join(prefix, 'lib', `${name}.so`))
    mkdirSync(join(prefix, 'bin'), { recursive: true })
    writeFileSync(join(prefix, 'bin', 'openssl'), `#!/bin/bash\nset -eu\n${capture}\nfixture_record openssl "$@"\nprintf 'OpenSSL 3.5.7 9 Jun 2026\\n'\n`)
    chmodSync(join(prefix, 'bin', 'openssl'), 0o755)
    const recorded = invoke(node, [join(directory, 'scripts', 'ci-openssl-binding.mjs'), 'record-install', prefix], selected)
    assert.equal(recorded.status, 0, recorded.stdout + recorded.stderr)
    return selected
  }
  const executable = put('selected.test', `#!/bin/bash
set -eu
${capture}
fixture_record test "$@"
printf 'selected fixture stdout\n'
printf 'selected fixture stderr\n' >&2
fixture_trace="$LD_DEBUG_OUTPUT.$$"
case "\${CI_OPENSSL_FIXTURE_LOADER_MODE:-selected}" in
  missing) rm -f "$fixture_trace" ;;
  *)
    printf '%s: transferring control: %s\n' "$$" "$0" >> "$fixture_trace"
    fixture_library_root="$FOREMAN_CODE_CI_OPENSSL_PREFIX/lib"
    if [ "\${CI_OPENSSL_FIXTURE_LOADER_MODE:-selected}" = wrong ]; then fixture_library_root="$CI_OPENSSL_FIXTURE_WRONG_LIBRARIES"; fi
    printf '%s: calling init: %s/libcrypto.so.3\n' "$$" "$fixture_library_root" >> "$fixture_trace"
    printf '%s: calling init: %s/libssl.so.3\n' "$$" "$fixture_library_root" >> "$fixture_trace"
    ;;
esac
exit "\${CI_OPENSSL_FIXTURE_TEST_EXIT:-0}"
`, true)
  const wrongLibraries = join(directory, 'wrong-libraries')
  mkdirSync(wrongLibraries)
  for (const name of ['libcrypto.so.3', 'libssl.so.3']) writeFileSync(join(wrongLibraries, name), 'synthetic wrong library\n')
  return { directory, state, cache, home, environment, configured, seedInstallation,
    run: (command, overrides) => invoke('/bin/bash', [helper, command], overrides),
    execute: (selected, overrides = {}) => invoke(node, [join(directory, 'scripts', 'ci-openssl-test-exec.mjs'), executable, '-test.run', '^TestSelected$'],
      { ...selected, CI_OPENSSL_FIXTURE_WRONG_LIBRARIES: wrongLibraries, ...overrides }),
    calls: () => readdirSync(callsDirectory).filter(name => name.endsWith('.args')).sort().map(name => ({
      tool: name.split('.')[0], args: readFileSync(join(callsDirectory, name), 'utf8').split('\0').filter(Boolean),
      environment: decodeEnvironment(readFileSync(join(callsDirectory, name.replace(/\.args$/, '.environment')), 'utf8')) })),
    prerequisite: () => JSON.parse(readFileSync(join(state, 'go/openssl/prerequisite.json'), 'utf8')),
    invocations: () => readdirSync(join(state, 'go/openssl')).filter(name => name.startsWith('test-')).sort()
      .map(name => JSON.parse(readFileSync(join(state, 'go/openssl', name, 'result.json'), 'utf8'))) }
}
