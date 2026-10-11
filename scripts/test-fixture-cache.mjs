import { Buffer } from 'node:buffer'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, open, rename, rm } from 'node:fs/promises'
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
  const { stdout: allowlist } = await execute('git', ['show', `${commit}:scripts/worker-api-allowlist.json`], {
    cwd: repository,
  })
  const paths = [
    ...JSON.parse(allowlist), 'apps/worker/src', 'apps/worker/artifacts', 'packages/contracts/src',
    'apps/web/public/graphql.svg', 'scripts/build-worker-artifact.mjs', 'scripts/worker-artifact-files.mjs',
    'scripts/worker-api-allowlist.json', 'scripts/quota-helper-abi.mjs', 'scripts/graphql-mcp.mjs',
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
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Invalid fixture cache entry')
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
  const parent = join(root, namespace)
  await mkdir(parent, { recursive: true, mode: 0o700 })
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
