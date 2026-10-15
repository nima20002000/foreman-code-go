import { Buffer } from 'node:buffer'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)

export function testFixtureCacheRoot(environment = process.env) {
  return environment.FOREMAN_CODE_TEST_CACHE_ROOT
    ?? fileURLToPath(new URL('../apps/api/node_modules/.cache/fixtures', import.meta.url))
}

/** Git blob identities let unchanged packaging inputs survive unrelated commits. */
export async function workerFixtureInputs(repository, commit) {
  const paths = [
    'apps/api/src', 'apps/worker/src', 'apps/worker/artifacts', 'packages/contracts/src',
    'apps/web/public/graphql.svg', 'scripts/build-worker-artifact.mjs', 'scripts/worker-artifact-files.mjs',
    'scripts/quota-helper-abi.mjs', 'scripts/graphql-mcp.mjs',
    'scripts/worker-snapshot-policy.mjs', 'scripts/ci-watchdog.mjs', 'scripts/ci-progress-reporter.mjs',
    'scripts/ci-test-results.mjs', 'scripts/dense-resources.mjs',
    'scripts/verification-runner.mjs', 'scripts/verify-repository.mjs', 'scripts/verification-reports.mjs',
    'scripts/integration-process.mjs', 'scripts/integration-capabilities.mjs',
    'packages/contracts/package.json', 'apps/worker/package.json', 'package.json',
    'pnpm-workspace.yaml', 'pnpm-lock.yaml',
  ]
  const { stdout } = await execute('git', ['ls-tree', '-r', '-z', commit, '--', ...paths], {
    cwd: repository, encoding: 'buffer', maxBuffer: 4 * 1024 * 1024,
  })
  return stdout
}

async function cacheEntryExists(directory) {
  try {
    const entry = await lstat(directory)
    const owned = !process.getuid || entry.uid === process.getuid()
    if (!entry.isDirectory() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0
      || !owned) throw new Error('Invalid fixture cache entry')
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

async function lockCacheEntry(handle) {
  // The inherited descriptor shares the lock until this parent closes it.
  await new Promise((resolve, reject) => {
    const child = spawn('flock', ['--exclusive', '3'], {
      stdio: ['ignore', 'ignore', 'inherit', handle.fd],
    })
    child.once('error', reject)
    child.once('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`Fixture cache lock failed (${code})`))
    })
  })
}

/** Only immutable setup output is shared. Rename publishes a complete entry. */
export async function cachedTestFixture(root, namespace, inputs, populate) {
  const hash = createHash('sha256')
  for (const input of inputs) {
    hash.update(String(Buffer.byteLength(input)))
    hash.update(':')
    hash.update(input)
  }
  await mkdir(join(root, namespace), { recursive: true, mode: 0o700 })
  // Cache storage may have a symlinked ancestor; consumers require canonical private roots.
  const parent = await realpath(join(root, namespace))
  const key = hash.digest('hex')
  const directory = join(parent, key)
  if (await cacheEntryExists(directory)) return directory
  const handle = await open(join(parent, `${key}.lock`), 'a', 0o600)
  try {
    await lockCacheEntry(handle)
    if (await cacheEntryExists(directory)) return directory
    const temporary = await mkdtemp(join(parent, `${key}.pending-`))
    try {
      await populate(temporary)
      await rename(temporary, directory)
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
    return directory
  } finally {
    await handle.close()
  }
}

/** A cached release is a donor when its recorded source snapshot is still the committed content and it was
 * built for the same target and host. Only the files the release really bundled define it. */
async function releaseDonor(parent, repository, commit, identity, status) {
  for (const name of await readdir(parent)) {
    if (name.endsWith('.lock') || name.includes('.pending-')) continue
    const directory = join(parent, name)
    try {
      if ((await readFile(join(directory, 'identity'), 'utf8')) !== identity) continue
      const { sourceSnapshot } = JSON.parse(await readFile(join(directory, 'release', 'manifest.json'), 'utf8'))
      const files = sourceSnapshot.files
      const { stdout } = await execute('git', ['ls-tree', '-r', '-z', commit, '--', ...files.map(file => file.path)], {
        cwd: repository, maxBuffer: 4 * 1024 * 1024,
      })
      const current = new Map(stdout.split('\0').filter(Boolean).map(line => {
        const [meta, path] = line.split('\t')
        return [path, meta.split(' ')[2]]
      }))
      if (files.every(file => current.get(file.path) === file.gitBlobSha1)) return directory
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError) && !(error instanceof TypeError)) throw error
      status.status = 'invalid'
      status.lastError = 'Release donor metadata is invalid or incomplete.'
    }
  }
  return null
}

/** Worker release cache. The exact-input key finds a direct hit; otherwise an earlier release whose bundled
 * files are unchanged is copied under the new key instead of rebuilt, so later jobs hit directly. */
export async function cachedWorkerRelease(root, repository, commit, identityParts, build, options = {}) {
  const inputs = await workerFixtureInputs(repository, commit)
  const identity = createHash('sha256').update(JSON.stringify(identityParts.map(String))).digest('hex')
  const status = { status: 'hit', lastError: null, missCount: 0, rebuildCount: 0 }
  const directory = await cachedTestFixture(root, 'worker-artifacts', [inputs, ...identityParts.map(String)], async temporary => {
    status.status = 'miss'
    status.missCount++
    const parent = await realpath(join(root, 'worker-artifacts'))
    const donor = await releaseDonor(parent, repository, commit, identity, status)
    status.rebuildCount = donor ? 0 : 1
    options.onCacheStatus?.({ ...status })
    if (status.lastError) console.warn('Release cache unavailable', JSON.stringify(status))
    if (donor) await cp(join(donor, 'release'), join(temporary, 'release'), { recursive: true, preserveTimestamps: true })
    else {
      await build(temporary)
    }
    await writeFile(join(temporary, 'identity'), identity, { mode: 0o600 })
  })
  if (status.status === 'hit') options.onCacheStatus?.({ ...status })
  return directory
}
