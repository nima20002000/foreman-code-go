import { execFileSync, spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const source = '7dac7b069c45b789663b6c64bf1b525759ba08c5'
const parent = join(await realpath(homedir()), '.cache', 'foreman-go-cleanup-investigation')
await mkdir(parent, { recursive: true, mode: 0o700 })
const root = await mkdtemp(join(parent, 'g-'))
const commands = join(root, 'commands')
const cache = join(root, 'compiler-cache')
const events = join(root, 'events.jsonl')
const record = value => console.log('[cleanup-investigation] ' + JSON.stringify(value))
const facts = { source,
  checkoutSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  diagnosticOnly: true, consumerTestsExecuted: 0, cleanup: false }
const env = { PATH: commands + ':' + process.env.PATH, HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'),
  XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
  FOREMAN_CODE_CI_GO_CACHE: cache, FOREMAN_PROBE_OBSERVATION_STATE: join(root, 'observation.json'),
  GOROOT: join(root, 'stale-goroot'), SUITE: 'unit', LANG: 'C.UTF-8', LC_ALL: 'C' }
let exitCode = 1
const progress = setInterval(() => record({ stage: 'running-original-installer' }), 15000)
try {
  for (const path of [commands, env.HOME, env.TMPDIR, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME,
    env.XDG_STATE_HOME]) await mkdir(path, { recursive: true, mode: 0o700 })
  const realRm = execFileSync('/bin/sh', ['-c', 'command -v rm'], { encoding: 'utf8' }).trim()
  if (!realRm.startsWith('/')) throw new Error('Existing rm executable is required')
  await writeFile(events, '')
  await writeFile(env.FOREMAN_PROBE_OBSERVATION_STATE, JSON.stringify({ realRm, compilerPrefix: cache, events }))
  const observer = await readFile('scripts/test-support/ci-owned-rm-observer.cjs')
  await writeFile(join(commands, 'rm'), '#!' + process.execPath + '\n' + observer)
  await chmod(join(commands, 'rm'), 0o700)
  facts.startedAt = new Date().toISOString()
  record({ stage: 'start', source, checkoutSha: facts.checkoutSha, originalScriptUnchanged: true })
  exitCode = await new Promise((resolve, reject) => {
    const child = spawn('bash', ['scripts/ci-go-toolchain.sh', 'install'], { env, stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', code => resolve(code ?? 1))
  })
  facts.finishedAt = new Date().toISOString()
  facts.originalInstallerExitCode = exitCode
  facts.failureSiteObservations = (await readFile(events, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
  facts.cleanupFailureReproduced = facts.failureSiteObservations.some(event => event.originalRmExitCode !== 0)
  facts.interpretation = facts.cleanupFailureReproduced ? 'Failure-site evidence only; not a green gate'
    : 'Original cleanup race was not reproduced; this is not evidence of a fix and will not be repeated unchanged'
} catch (error) {
  facts.diagnosticError = error.code ?? error.name
  exitCode = 1
} finally {
  clearInterval(progress)
  try { await rm(root, { recursive: true, force: true }); facts.cleanup = true }
  catch (error) { facts.finalCleanupError = error.code; exitCode = 1 }
  record({ stage: 'result', ...facts })
}
process.exitCode = exitCode
