import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { writeJsonReport } from './ci-report-io.mjs'

const directory = dirname(fileURLToPath(import.meta.url))
const helpers = ['ci-openssl-versions.json', 'ci-openssl-toolchain.sh', 'ci-openssl-binding.c',
  'ci-openssl-binding.mjs', 'ci-openssl-test-exec.mjs']
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

function pins() {
  const pin = JSON.parse(readFileSync(join(directory, 'ci-openssl-versions.json'), 'utf8')).openssl
  if (pin?.version !== '3.5.7' || !/^[a-f0-9]{64}$/.test(pin.sha256)
    || !Number.isSafeInteger(pin.size) || pin.size <= 0
    || pin.url !== `https://github.com/openssl/openssl/releases/download/openssl-${pin.version}/openssl-${pin.version}.tar.gz`
    || !Number.isFinite(Date.parse(pin.released)) || Date.now() - Date.parse(pin.released) < 48 * 3_600_000) {
    throw new Error('The OpenSSL prerequisite needs the pinned official 3.5.7 source, size, checksum and release date.')
  }
  return pin
}

function configuration(values) {
  const [platform, compiler, compilerHash, compilerVersion, compilerTarget, libc, pkgConfig, pkgConfigHash, pkgConfigVersion, cacheRoot] = values
  if (values.length !== 10 || !['linux-amd64', 'linux-arm64'].includes(platform)
    || !/^[a-f0-9]{64}$/.test(compilerHash) || !/^[a-f0-9]{64}$/.test(pkgConfigHash)
    || !/^glibc \d+\.\d+$/.test(libc) || values.some(value => !value) || cacheRoot !== resolve(cacheRoot)) {
    throw new Error('OpenSSL CI requires identified Linux/glibc, C compiler and pkg-config inputs.')
  }
  const pin = pins()
  const helperDigests = Object.fromEntries(helpers.map(name => [name, digest(readFileSync(join(directory, name)))]))
  const identity = { platform, compiler, compilerHash, compilerVersion, compilerTarget, libc, cacheRoot,
    pkgConfig, pkgConfigHash, pkgConfigVersion, source: pin, helperDigests,
    build: { configure: ['shared', 'no-tests', '--libdir=lib'], cflags: '-O2 -fPIC',
      cgoCflags: '-O2 -g', cgoLdflags: '-O2 -g', binding: 'pkg-config:openssl',
      libraryPath: '<private-prefix>/lib', opensslDirectory: '<private-prefix>/ssl' } }
  const hash = createHash('sha256')
  for (const [name, value] of Object.entries(helperDigests)) hash.update(name).update('\0').update(value).update('\0')
  for (const value of values) hash.update(value).update('\0')
  hash.update(JSON.stringify(identity.build))
  const key = hash.digest('hex')
  process.stdout.write([pin.version, key, pin.url, pin.sha256, String(pin.size),
    Buffer.from(JSON.stringify(identity)).toString('base64')].join('\n') + '\n')
}

export function opensslState(environment = process.env) {
  const pin = pins()
  const key = environment.FOREMAN_CODE_CI_OPENSSL_KEY
  const cache = environment.FOREMAN_CODE_CI_OPENSSL_CACHE
  const prefix = environment.FOREMAN_CODE_CI_OPENSSL_PREFIX
  if (!/^[a-f0-9]{64}$/.test(key ?? '') || !cache || !prefix || !environment.CI_STATE
    || prefix !== join(resolve(cache), 'toolchains', `openssl-${pin.version}-${key}`)) {
    throw new Error('The selected OpenSSL prerequisite needs its exact private CI cache and run state.')
  }
  return { pin, key, cache: resolve(cache), prefix, state: join(resolve(environment.CI_STATE), 'go', 'openssl') }
}

function regularFile(root, relative) {
  const path = join(root, relative)
  const resolvedRoot = realpathSync(root)
  const resolved = realpathSync(path)
  if (!resolved.startsWith(`${resolvedRoot}${sep}`) || !statSync(resolved).isFile()) {
    throw new Error(`OpenSSL cache input must remain a regular file inside its owned prefix: ${relative}`)
  }
  const bytes = readFileSync(resolved)
  return { path: relative, size: bytes.length, sha256: digest(bytes) }
}

function treeFiles(root, relative) {
  const directoryPath = join(root, relative)
  if (!existsSync(directoryPath)) return []
  if (!lstatSync(directoryPath).isDirectory()) throw new Error(`OpenSSL cache directory must be owned: ${relative}`)
  return readdirSync(directoryPath).sort().flatMap(name => {
    const child = join(relative, name)
    return lstatSync(join(root, child)).isDirectory() ? treeFiles(root, child) : [child]
  })
}

function inventory(root) {
  const headers = treeFiles(root, 'include/openssl')
  if (!headers.includes('include/openssl/opensslv.h') || !headers.includes('include/openssl/ssl.h')) {
    throw new Error('The selected OpenSSL development headers are missing.')
  }
  const files = [...headers, 'bin/openssl', 'lib/libcrypto.so', 'lib/libcrypto.so.3', 'lib/libssl.so', 'lib/libssl.so.3',
    'lib/pkgconfig/openssl.pc', 'lib/pkgconfig/libcrypto.pc', 'lib/pkgconfig/libssl.pc',
    ...treeFiles(root, 'lib/ossl-modules'), ...treeFiles(root, 'lib/engines-3')].sort()
  return files.map(relative => regularFile(root, relative))
}

function installationRecord(root) {
  const current = opensslState()
  const identity = JSON.parse(Buffer.from(process.env.FOREMAN_CODE_CI_OPENSSL_IDENTITY ?? '', 'base64').toString('utf8'))
  if (identity.source?.sha256 !== current.pin.sha256 || identity.source?.version !== current.pin.version) {
    throw new Error('OpenSSL install provenance does not match the committed source pin.')
  }
  writeJsonReport(join(root, 'installation.json'), { schemaVersion: 1, version: current.pin.version,
    cacheKey: current.key, prefix: current.prefix, identity, files: inventory(root) })
}

export function verifyOpenSSLInstallation(environment = process.env) {
  const current = opensslState(environment)
  const record = JSON.parse(readFileSync(join(current.prefix, 'installation.json'), 'utf8'))
  if (record.schemaVersion !== 1 || record.version !== current.pin.version || record.cacheKey !== current.key
    || record.prefix !== current.prefix || record.identity?.source?.sha256 !== current.pin.sha256
    || JSON.stringify(record.files) !== JSON.stringify(inventory(current.prefix))) {
    throw new Error('The cached OpenSSL installation does not match its pinned source and recorded development/library inputs.')
  }
  for (const name of helpers) {
    if (record.identity.helperDigests[name] !== digest(readFileSync(join(directory, name)))) {
      throw new Error('The cached OpenSSL installation was prepared by different CI prerequisite helpers.')
    }
  }
  return { ...current, installation: record }
}

export function isolatedOpenSSLEnvironment(environment, current, state = current.state) {
  const result = { ...environment }
  for (const name of Object.keys(result)) {
    if (name.startsWith('OPENSSL_') || ['SSLKEYLOGFILE', 'LD_PRELOAD', 'LD_AUDIT', 'LD_DEBUG',
      'LD_DEBUG_OUTPUT', 'NODE_OPTIONS', 'CTLOG_FILE', 'RANDFILE'].includes(name)) delete result[name]
  }
  mkdirSync(join(state, 'certs'), { recursive: true, mode: 0o700 })
  for (const name of ['openssl.cnf', 'certs.pem', 'ct-logs.cnf']) writeFileSync(join(state, name), '', { mode: 0o600 })
  return { ...result, OPENSSL_CONF: join(state, 'openssl.cnf'), OPENSSL_CONF_INCLUDE: state,
    SSL_CERT_FILE: join(state, 'certs.pem'), SSL_CERT_DIR: join(state, 'certs'),
    CTLOG_FILE: join(state, 'ct-logs.cnf'), RANDFILE: join(state, 'random-state'),
    OPENSSL_MODULES: join(current.prefix, 'lib', 'ossl-modules'),
    OPENSSL_ENGINES: join(current.prefix, 'lib', 'engines-3'), LD_LIBRARY_PATH: join(current.prefix, 'lib'),
    FOREMAN_TLS_OPENSSL: join(current.prefix, 'bin', 'openssl') }
}

function pkgConfigArguments(output) {
  const arguments_ = []
  let argument = '', quote = '', escaped = false, active = false
  for (const character of output) {
    if (escaped) { argument += character; escaped = false; active = true; continue }
    if (character === '\\' && quote !== "'") { escaped = true; active = true; continue }
    if (quote) {
      if (character === quote) quote = ''
      else argument += character
      continue
    }
    if (character === '"' || character === "'") { quote = character; active = true; continue }
    if (/\s/.test(character)) {
      if (active) { arguments_.push(argument); argument = ''; active = false }
    } else { argument += character; active = true }
  }
  if (quote || escaped) throw new Error('pkg-config returned an incomplete quoted or escaped argument.')
  if (active) arguments_.push(argument)
  return arguments_
}

function compileBinding(temporary) {
  const current = verifyOpenSSLInstallation()
  const destination = realpathSync(temporary)
  if (dirname(destination) !== realpathSync(current.state) || !/^prerequisite\.[A-Za-z0-9]+$/.test(basename(destination))
    || !lstatSync(temporary).isDirectory()) {
    throw new Error('The fixed OpenSSL binding compiler needs the current owned prerequisite directory.')
  }
  const cflags = pkgConfigArguments(readFileSync(join(current.state, 'pkg-config.cflags'), 'utf8'))
  const libraries = pkgConfigArguments(readFileSync(join(current.state, 'pkg-config.libs'), 'utf8'))
  const compiler = current.installation.identity.compiler
  const arguments_ = ['-O2', '-fPIC', ...cflags, join(directory, 'ci-openssl-binding.c'),
    '-o', join(destination, 'binding'), ...libraries, '-ldl']
  const outcome = spawnSync(compiler, arguments_, { cwd: directory,
    env: isolatedOpenSSLEnvironment(process.env, current), stdio: 'inherit', timeout: 120_000 })
  const actionExit = outcome.error || outcome.signal || outcome.status !== 0 ? 1 : 0
  writeJsonReport(join(current.state, 'binding-command.json'), { schemaVersion: 1,
    scope: 'prerequisite-compile', nativeTestCount: 0, cacheKey: current.key,
    compiler, arguments: arguments_, pkgConfig: { cflags, libraries },
    nativeExit: outcome.status, signal: outcome.signal, actionExit, error: outcome.error?.message ?? null })
  if (actionExit !== 0) throw new Error('The fixed OpenSSL binding probe compiler failed; see binding-command.json.')
}

function prerequisiteRecord(probeFile, cflagsFile, librariesFile, cgo, compiler, cliFile) {
  const current = verifyOpenSSLInstallation()
  const compilation = JSON.parse(readFileSync(join(current.state, 'binding-command.json'), 'utf8'))
  if (compilation.scope !== 'prerequisite-compile' || compilation.cacheKey !== current.key
    || compilation.compiler !== compiler || compilation.actionExit !== 0 || compilation.nativeExit !== 0) {
    throw new Error('The selected OpenSSL prerequisite needs its successful fixed compiler command receipt.')
  }
  const probe = Object.fromEntries(readFileSync(probeFile, 'utf8').trim().split('\n').map(line => {
    const separator = line.indexOf('=')
    if (separator <= 0) throw new Error('The OpenSSL binding probe did not report a complete result.')
    return [line.slice(0, separator), line.slice(separator + 1)]
  }))
  if (cgo !== '1' || compiler !== current.installation.identity.compiler) {
    throw new Error('OpenSSL provider qualification requires the selected C compiler and actual CGO_ENABLED=1.')
  }
  if (probe.headerVersion !== current.pin.version || !probe.runtimeVersion?.startsWith(`OpenSSL ${current.pin.version} `)
    || probe.provider !== 'default' || probe.context !== 'created') {
    throw new Error('The selected OpenSSL headers, runtime version and default-provider binding must match 3.5.7.')
  }
  const cliVersion = readFileSync(cliFile, 'utf8').trim()
  const cliPath = join(current.prefix, 'bin', 'openssl')
  if (process.env.FOREMAN_TLS_OPENSSL !== cliPath || cliVersion !== probe.runtimeVersion) {
    throw new Error('The selected R fixture CLI must come from the same pinned OpenSSL installation and runtime version.')
  }
  for (const [field, file] of [['cryptoPath', 'libcrypto.so.3'], ['sslPath', 'libssl.so.3']]) {
    if (!probe[field] || realpathSync(probe[field]) !== realpathSync(join(current.prefix, 'lib', file))) {
      throw new Error(`The OpenSSL binding probe loaded ${file} outside the selected private installation.`)
    }
  }
  writeJsonReport(join(current.state, 'prerequisite.json'), { schemaVersion: 1, profile: 'openssl',
    cacheKey: current.key, version: current.pin.version, prefix: current.prefix,
    identity: current.installation.identity, files: current.installation.files,
    pkgConfig: { cflags: readFileSync(cflagsFile, 'utf8').trim(), libraries: readFileSync(librariesFile, 'utf8').trim() },
    compilation, binding: probe, cliVersion, cliPath, cgoEnabled: cgo, goCompiler: compiler,
    scope: 'prerequisite-only', nativeTestCount: 0 })
}

export function verifyOpenSSLTestLoader(current, trace, executable) {
  const mapped = trace.split('\n').map(line => line.match(/^\s*\d+:\s+calling init:\s+(.+?)\s*$/)?.[1]).filter(Boolean)
  const transferred = trace.split('\n').map(line => line.match(/^\s*\d+:\s+transferring control:\s+(.+?)\s*$/)?.[1]).filter(Boolean)
  if (!transferred.some(path => realpathSync(path) === realpathSync(executable))) {
    throw new Error('The loader evidence does not identify the actual selected Go test process.')
  }
  return ['libcrypto.so.3', 'libssl.so.3'].map(name => {
    const expected = realpathSync(join(current.prefix, 'lib', name))
    const candidates = mapped.filter(path => basename(path).startsWith(name.replace('.so.3', '.so')))
    if (!candidates.length || candidates.some(path => realpathSync(path) !== expected)) {
      throw new Error(`The actual Go test process did not load only the selected OpenSSL ${name}.`)
    }
    const record = current.installation.files.find(file => file.path === `lib/${name}`)
    const sha256 = digest(readFileSync(expected))
    if (record?.sha256 !== sha256) throw new Error(`The loaded OpenSSL ${name} changed after prerequisite verification.`)
    return { name, path: expected, size: record.size, sha256 }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    switch (process.argv[2]) {
      case 'configuration': configuration(process.argv.slice(3)); break
      case 'record-install': installationRecord(process.argv[3]); break
      case 'verify-install': verifyOpenSSLInstallation(); break
      case 'compile-binding': compileBinding(process.argv[3]); break
      case 'record-prerequisite': prerequisiteRecord(...process.argv.slice(3)); break
      default: throw new Error('Usage: ci-openssl-binding.mjs configuration|record-install|verify-install|compile-binding|record-prerequisite')
    }
  } catch (error) { console.error(error); process.exitCode = 1 }
}
