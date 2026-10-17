import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { availableParallelism, homedir } from 'node:os'
import { dirname, join } from 'node:path'

const source = '0e40b1dbe160f02c88e94a3508e3fafcd3213bea'
const parent = join(await realpath(homedir()), '.cache', 'foreman-main-go-diagnostic')
await mkdir(parent, { recursive: true, mode: 0o700 })
const root = await mkdtemp(join(parent, 'g-'))
const cache = join(root, 'compiler-cache')
const env = { PATH: process.env.PATH, HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'),
  XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
  FOREMAN_CODE_CI_GO_CACHE: cache, GOROOT: join(root, 'stale-goroot'), SUITE: 'unit',
  LANG: 'C.UTF-8', LC_ALL: 'C', GOENV: 'off', GOWORK: 'off', GOTOOLCHAIN: 'local',
  GOPROXY: 'https://proxy.golang.org', GOSUMDB: 'sum.golang.org',
  GOFLAGS: '-mod=readonly -p=' + Math.min(2, availableParallelism()),
  GOCACHE: join(root, 'build'), GOMODCACHE: join(root, 'modules'), GOPATH: join(root, 'gopath'), GOTMPDIR: join(root, 'tmp') }
const record = value => console.log('[main-go] ' + JSON.stringify(value))
const facts = { source, commands: [],
  checkoutSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  selectedPackage: './internal/domainerror',
  selectedTest: 'TestPublicFailureClassRetainsKnownCodesAndExplicitRetryability', cleanup: false }
let failed = false
let stage = 'setup'
const progress = setInterval(() => record({ stage: 'running', command: stage }), 15000)

async function run(name, program, args, options = {}) {
  stage = name
  const startedAt = new Date().toISOString()
  record({ stage: 'command-start', name })
  let stdout = ''
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: options.cwd ?? process.cwd(), env: options.env ?? env,
      stdio: ['pipe', 'pipe', 'inherit'] })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', text => { stdout += text; if (!options.captureOnly) process.stdout.write(text) })
    child.once('error', reject)
    child.once('close', code => resolve(code ?? 1))
    child.stdin.end(options.input)
  })
  facts.commands.push({ name, exitCode, startedAt, finishedAt: new Date().toISOString() })
  record({ stage: 'command-finish', ...facts.commands.at(-1) })
  return { exitCode, stdout }
}

try {
  for (const path of [env.HOME, env.TMPDIR, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME,
    env.XDG_STATE_HOME, env.GOCACHE, env.GOMODCACHE, env.GOPATH]) await mkdir(path, { recursive: true, mode: 0o700 })
  const sentinel = join(root, 'caller-sentinel')
  await writeFile(sentinel, 'caller-owned-state\n', { mode: 0o600 })
  record({ stage: 'provenance', source, checkoutSha: facts.checkoutSha, selectedTest: facts.selectedTest,
    staleGorootProvided: true, cacheOwned: true })
  const installed = await run('public-install', 'bash', ['scripts/ci-go-toolchain.sh', 'install'])
  if (installed.exitCode !== 0) throw new Error('Public Go installer failed')
  const verified = await run('public-verify', 'bash', ['scripts/ci-go-toolchain.sh', 'verify'])
  if (verified.exitCode !== 0) throw new Error('Public Go compiler verification failed')
  const goroot = join(cache, 'toolchains', 'go1.27.2')
  const go = join(goroot, 'bin/go')
  const compilerEnv = { ...env, GOROOT: goroot }
  const version = await run('compiler-version', go, ['version'], { env: compilerEnv })
  facts.compilerVersion = version.stdout.trim()
  if (version.exitCode !== 0 || facts.compilerVersion !== 'go version go1.27.2 linux/amd64') {
    throw new Error('Installed compiler does not match the pinned Go version')
  }
  const result = await run('selected-real-Go-test', go,
    ['test', '-json', '-count=1', '-run', '^' + facts.selectedTest + '$', './internal/domainerror'],
    { cwd: 'backend', env: compilerEnv, captureOnly: true })
  process.stdout.write(result.stdout)
  facts.rawJsonBytes = Buffer.byteLength(result.stdout)
  facts.rawJsonSha256 = createHash('sha256').update(result.stdout).digest('hex')
  const records = result.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line))
  facts.namedTests = records.filter(item => item.Test && ['pass', 'fail', 'skip'].includes(item.Action))
    .map(item => ({ name: item.Test, status: item.Action, elapsed: item.Elapsed }))
  if (result.exitCode !== 0 || facts.namedTests.length !== 7 || facts.namedTests.some(item => item.status !== 'pass')) {
    throw new Error('The one selected Go consumer did not pass all six subcases and its root')
  }
  const report = join(root, 'selected.vitest.json')
  const module = /^module\s+(.+)$/m.exec(await readFile('backend/go.mod', 'utf8'))[1]
  const converted = await run('original-Go-result-converter', process.execPath,
    ['scripts/ci-go-test-results.mjs', '--module', module, '--output', report,
      '--durations', join(root, 'durations.json')], { input: result.stdout })
  if (converted.exitCode !== 0) throw new Error('Original Go result conversion failed')
  if (process.env.TEST_RESULTS_OUTPUT) {
    await mkdir(dirname(process.env.TEST_RESULTS_OUTPUT), { recursive: true })
    await writeFile(process.env.TEST_RESULTS_OUTPUT, await readFile(report))
  }
  facts.callerSentinelUnchanged = (await readFile(sentinel, 'utf8')) === 'caller-owned-state\n'
  if (!facts.callerSentinelUnchanged) throw new Error('Caller sentinel changed')
} catch (error) {
  failed = true
  facts.failure = error.message.replaceAll(root, '<owned-cache>')
} finally {
  clearInterval(progress)
  await rm(root, { recursive: true, force: true })
  facts.cleanup = true
  facts.failed = failed
  record({ stage: 'result', ...facts })
}
process.exitCode = failed ? 1 : 0
