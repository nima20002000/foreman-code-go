import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { affectedContracts, affectedContractsKey, contractsEmitCommand, contractsEntryOutputs } from './ci-affected-contracts.mjs'
import { deferredHostIntegration, environmentRequest, explicitRelease, validateAffectedSuite } from './ci-affected-scope.mjs'

const script = fileURLToPath(import.meta.url)

function affectedPlan(root) {
  const inCi = ['true', '1'].includes(process.env.CI) || process.env.CI_HOST_RUNNER === '1'
    || process.env.FOREMAN_CODE_CI_HOST === '1' || process.env.FOREMAN_CODE_CI_LOCAL === '1'
  if (!inCi || explicitRelease(process.env, root)) return null
  if (deferredHostIntegration()) return { entries: [], sources: [], deferred: true }
  const input = environmentRequest(process.env, root)
  const request = process.env.SUITE ? validateAffectedSuite(process.env.SUITE, input, root) : input
  if (!request.files.length) throw new Error('Contracts setup received an empty affected scope.')
  return affectedContracts(request, root)
}

function selectedReady(root, plan, key) {
  const output = join(root, 'packages/contracts/dist')
  const stamp = join(output, '.ci-cache-key')
  return !plan.entries.length || existsSync(stamp) && readFileSync(stamp, 'utf8') === key
    && contractsEntryOutputs(plan).every(file => existsSync(join(output, file)))
}

function selectedReceipt(root, plan, details) {
  if (!process.env.CI_STATE) return
  const output = join(resolve(root, process.env.CI_STATE), 'go/contracts-preparation.json')
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, JSON.stringify({ schema: 1, entries: plan.entries, sources: plan.sources,
    sourceSha256: Object.fromEntries(plan.sources.map(file => [file, createHash('sha256')
      .update(readFileSync(join(root, file))).digest('hex')])), ...details }, null, 2), { mode: 0o600 })
}

function selectedBuild(root, cache, plan) {
  // Resolve this before cache keys, dist checks or the inherited full compiler command.
  if (!plan.entries.length) {
    selectedReceipt(root, plan, { mode: plan.deferred ? 'deferred' : 'bypass', command: null, exitCode: 0 })
    console.log(plan.deferred ? '[ci-setup] contracts setup deferred until the host supplies exact integration files'
      : '[ci-cache] selected checks need no emitted contracts')
    return 0
  }
  const key = affectedContractsKey(root, plan)
  const output = join(root, 'packages/contracts/dist')
  if (selectedReady(root, plan, key)) {
    selectedReceipt(root, plan, { mode: 'ready', key, command: null, exitCode: 0 })
    return 0
  }
  const cached = join(cache, key)
  if (existsSync(join(cached, '.ci-cache-key')) && readFileSync(join(cached, '.ci-cache-key'), 'utf8') === key
    && contractsEntryOutputs(plan).every(file => existsSync(join(cached, file)))) {
    rmSync(output, { recursive: true, force: true })
    copy(cached, output)
    selectedReceipt(root, plan, { mode: 'cache', key, command: null, exitCode: 0 })
    return 0
  }
  const temporary = join(cache, `${key}.${randomUUID()}`)
  mkdirSync(temporary, { recursive: true })
  try {
    const command = contractsEmitCommand(root, plan, temporary)
    selectedReceipt(root, plan, { mode: 'compiling', key, command, exitCode: null })
    const result = spawnSync(command[0], command.slice(1), { cwd: join(root, 'packages/contracts'),
      stdio: 'inherit', env: process.env })
    selectedReceipt(root, plan, { mode: 'compiler', key, command, exitCode: result.status,
      signal: result.signal, error: result.error?.message ?? null })
    if (result.error) throw result.error
    if (result.status !== 0) return result.status ?? 1
    for (const file of plan.sources.filter(file => /\.d\.[cm]?ts$/.test(file))) {
      const destination = join(temporary, file.slice('packages/contracts/src/'.length))
      // A handwritten companion can declare public types that JavaScript inference cannot emit.
      mkdirSync(dirname(destination), { recursive: true })
      copyFileSync(join(root, file), destination)
    }
    if (!contractsEntryOutputs(plan).every(file => existsSync(join(temporary, file)))) {
      throw new Error('The selected contracts compiler omitted a required export.')
    }
    writeFileSync(join(temporary, '.ci-cache-key'), key)
    rmSync(cached, { recursive: true, force: true })
    renameSync(temporary, cached)
    rmSync(output, { recursive: true, force: true })
    copy(cached, output)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
  return 0
}

export function contractsCacheKey(root) {
  const tree = spawnSync('git', ['rev-parse', 'HEAD:packages/contracts'], { cwd: root, encoding: 'utf8' })
  if (tree.status !== 0) throw new Error(tree.stderr || 'Cannot read contracts inputs')
  const hash = createHash('sha256').update(process.version).update(process.platform).update(process.arch).update(tree.stdout.trim())
  for (const name of ['pnpm-lock.yaml', 'tsconfig.base.json', 'tsconfig.json']) {
    if (existsSync(join(root, name))) hash.update(name).update(readFileSync(join(root, name)))
  }
  return hash.digest('hex')
}

export function contractsReady(root) {
  const output = join(root, 'packages/contracts/dist')
  const stamp = join(output, '.ci-cache-key')
  return existsSync(stamp) && existsSync(join(output, 'index.js'))
    && readFileSync(stamp, 'utf8') === contractsCacheKey(root)
}

function copy(source, destination) {
  mkdirSync(destination, { recursive: true })
  const result = spawnSync('cp', ['-a', '--reflink=auto', `${source}/.`, destination], { stdio: 'inherit' })
  if (result.status !== 0) throw new Error('Cannot copy contracts build')
}

function build(root, cache, command) {
  const key = contractsCacheKey(root)
  const output = join(root, 'packages/contracts/dist')
  const stamp = join(output, '.ci-cache-key')
  if (contractsReady(root)) {
    console.log('[ci-cache] contracts build reused')
    return 0
  }
  const cached = join(cache, key)
  if (existsSync(join(cached, '.ci-cache-key'))) {
    rmSync(output, { recursive: true, force: true })
    copy(cached, output)
    console.log('[ci-cache] contracts build restored')
    return 0
  }
  rmSync(output, { recursive: true, force: true })
  const result = spawnSync(command[0], command.slice(1), { cwd: process.cwd(), stdio: 'inherit', env: process.env })
  if (result.error) throw result.error
  if (result.status !== 0) return result.status ?? 1
  if (!existsSync(join(output, 'index.js'))) throw new Error('Contracts compiler produced no entry point')
  writeFileSync(stamp, key)
  const temporary = join(cache, `${key}.${randomUUID()}`)
  try {
    copy(output, temporary)
    renameSync(temporary, cached)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
  console.log('[ci-cache] contracts build saved')
  return 0
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [action, root, cachePath, divider, ...command] = process.argv.slice(2)
  const cache = root && cachePath ? resolve(root, cachePath) : null
  const plan = root ? affectedPlan(root) : null
  if (action === 'key' && root) console.log(plan ? affectedContractsKey(root, plan) : contractsCacheKey(root))
  else if (action === 'ready' && root) {
    process.exitCode = (plan ? selectedReady(root, plan, affectedContractsKey(root, plan)) : contractsReady(root)) ? 0 : 1
  } else if (['affected', 'affected-locked', 'build', 'locked-build'].includes(action) && root && cache
    && (action.startsWith('affected') ? plan : divider === '--' && command.length)) {
    if (plan && !plan.entries.length) {
      process.exitCode = selectedBuild(root, cache, plan)
    } else {
      mkdirSync(cache, { recursive: true })
      if (action === 'locked-build' || action === 'affected-locked') {
        process.exitCode = plan ? selectedBuild(root, cache, plan) : build(root, cache, command)
      } else {
        const key = plan ? affectedContractsKey(root, plan) : contractsCacheKey(root)
        const result = spawnSync('flock', [join(cache, `${key}.lock`), process.execPath, script,
          action === 'affected' ? 'affected-locked' : 'locked-build', root, cache, '--', ...command], { stdio: 'inherit' })
        if (result.error) throw result.error
        process.exitCode = result.status ?? 1
      }
    }
  } else throw new Error('Usage: ci-contracts.mjs key|ready root | affected root cache | build root cache -- compiler [args...]')
}
