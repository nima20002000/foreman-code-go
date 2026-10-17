import { spawn } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

process.umask(0o077)
const home = await realpath(homedir())
const oldParent = join(home, '.cache/foreman-main-go-diagnostic')
const oldRoot = join(oldParent, 'g-fDwDez')
const allowed = new Set(['compiler-cache', 'config', 'modules'])
const facts = { sourceTicket: 'e88097a3-9797-4568-9831-e83825b68916',
  priorCleanupTicket: '2b807e6b-ee72-4d85-83b0-f42398643797',
  metadataTicket: '5ddc004d-fd41-4e7e-8ba5-7819031ee49c', testsExecuted: 0,
  commands: [], oldRootRemoved: false, freshResourceRemoved: false, originalFailuresRetained: true }
let freshRoot
let failed = false
const record = value => console.log('[reviewed-owned-cleanup] ' + JSON.stringify(value))
const progress = setInterval(() => record({ stage: 'running' }), 15000)

async function ownedDirectory(path) {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()) {
    throw new Error('The recorded cleanup directory is not owned by this CI user')
  }
}
async function validateOldRoot() {
  await ownedDirectory(oldParent)
  try { await ownedDirectory(oldRoot) }
  catch (error) { if (error.code === 'ENOENT') return false; throw error }
  const entries = await readdir(oldRoot, { withFileTypes: true })
  if (entries.some(entry => !allowed.has(entry.name) || !entry.isDirectory() || entry.isSymbolicLink())) {
    throw new Error('The recorded remaining layout changed')
  }
  const pending = [oldRoot]
  let inspected = 0
  while (pending.length) {
    const path = pending.pop()
    const info = await lstat(path)
    if (info.uid !== process.getuid() || info.isSymbolicLink()) throw new Error('An old resource entry changed ownership or became a link')
    inspected += 1
    if (info.isDirectory()) {
      for (const entry of await readdir(path)) pending.push(join(path, entry))
    }
  }
  facts.validatedEntries = inspected
  facts.remainingRootNames = entries.map(entry => entry.name).sort()
  return true
}
async function run(name, program, args, env) {
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(program, args, { env, stdio: ['ignore', 'inherit', 'inherit'] })
    child.once('error', reject)
    child.once('close', code => resolve(code ?? 1))
  })
  facts.commands.push({ name, exitCode })
  record(facts.commands.at(-1))
  if (exitCode !== 0) throw new Error(name + ' failed')
}
try {
  if (!await validateOldRoot()) {
    facts.oldRootAlreadyAbsent = true
    facts.oldRootRemoved = true
  } else {
    const moduleCache = join(oldRoot, 'modules')
    let modulesPresent = true
    try { await ownedDirectory(moduleCache) }
    catch (error) { if (error.code !== 'ENOENT') throw error; modulesPresent = false }
    if (modulesPresent) {
      const parent = join(home, '.cache/foreman-main-go-cleanup')
      await mkdir(parent, { recursive: true, mode: 0o700 })
      freshRoot = await mkdtemp(join(parent, 'c-'))
      const env = { PATH: process.env.PATH, HOME: join(freshRoot, 'home'), TMPDIR: join(freshRoot, 'tmp'),
        XDG_CONFIG_HOME: join(freshRoot, 'config'), XDG_CACHE_HOME: join(freshRoot, 'cache'), XDG_STATE_HOME: join(freshRoot, 'state'),
        FOREMAN_CODE_CI_GO_CACHE: join(freshRoot, 'compiler'), GOROOT: join(freshRoot, 'stale-root'),
        GOTOOLCHAIN: 'local', GOENV: 'off', GOWORK: 'off', GOFLAGS: '-mod=readonly',
        GOPROXY: 'https://proxy.golang.org', GOSUMDB: 'sum.golang.org', SUITE: 'unit',
        GOCACHE: join(freshRoot, 'build'), GOPATH: join(freshRoot, 'gopath'), GOMODCACHE: join(freshRoot, 'modules') }
      for (const path of [env.HOME, env.TMPDIR, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, env.XDG_STATE_HOME]) {
        await mkdir(path, { recursive: true, mode: 0o700 })
      }
      await run('fresh-pinned-cleanup-tool', 'bash', ['scripts/ci-go-toolchain.sh', 'install'], env)
      const goroot = join(env.FOREMAN_CODE_CI_GO_CACHE, 'toolchains/go1.27.2')
      const go = join(goroot, 'bin/go')
      const cleanupEnv = { ...env, GOROOT: goroot, GOMODCACHE: moduleCache }
      await run('private-cleanup-telemetry-off', go, ['telemetry', 'off'], cleanupEnv)
      await validateOldRoot()
      await run('official-exact-old-module-cache-cleanup', go, ['clean', '-modcache'], cleanupEnv)
      try { await lstat(moduleCache); throw new Error('Old module cache still exists after official cleanup') }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    await validateOldRoot()
    await rm(oldRoot, { recursive: true, force: true })
    facts.oldRootRemoved = true
  }
} catch (error) {
  failed = true
  facts.failure = error.message.replaceAll(oldRoot, '<recorded-old-root>')
} finally {
  if (freshRoot) {
    try { await rm(freshRoot, { recursive: true, force: true }); facts.freshResourceRemoved = true }
    catch (error) { failed = true; facts.freshCleanupFailure = error.code ?? error.message }
  } else facts.freshResourceRemoved = true
  clearInterval(progress)
  facts.failed = failed
  record({ stage: 'result', ...facts })
}
process.exitCode = failed ? 1 : 0
