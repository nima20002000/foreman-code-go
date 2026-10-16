import assert from 'node:assert/strict'
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { workerContractAliases } from './worker-snapshot-policy.mjs'

const root = resolve(import.meta.dirname, '..')
const require = createRequire(join(root, 'apps/worker/package.json'))
const { build } = require('esbuild')
const contracts = require(join(root, 'packages/contracts/package.json'))

async function bundledModule(t, source) {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const directory = await mkdtemp(join(cache, 'worker-lock-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const output = join(directory, 'bundle.mjs')
  await build({
    absWorkingDir: root,
    entryPoints: [source],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    alias: workerContractAliases(contracts.exports),
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  })
  return { directory, module: await import(pathToFileURL(output).href) }
}

test('bundled private directory locks preserve exclusion without a native addon loader', async t => {
  const { directory, module } = await bundledModule(t, 'apps/api/src/modules/sources/privateFilesystem.ts')
  const handle = await open(directory, 'r')
  try {
    await module.withPrivateDirectoryLock(handle, async () => {
      await assert.rejects(
        module.withPrivateDirectoryLock(handle, async () => true, { nonBlocking: true }),
        { code: 'SOURCE_CLAIM_LOCK_FAILED' },
      )
    })
    assert.equal(await module.withPrivateDirectoryLock(handle, async () => 'released', { nonBlocking: true }), 'released')
  } finally {
    await handle.close()
  }
})

test('bundled launcher merges concurrent registrations without a native addon loader', async t => {
  const { directory, module } = await bundledModule(t, 'apps/api/src/modules/harnesses/appMcpLauncher.ts')
  const launcher = join(directory, 'launcher.mjs')
  const executables = Array.from({ length: 4 }, (_, index) => ({
    path: `/runtime/node-${index}`,
    realpath: `/runtime/node-${index}`,
  }))
  await Promise.all(executables.map(executable => module.writeLauncherInstallation(launcher, {
    version: 1,
    executables: [executable],
  })))
  assert.deepEqual(
    module.readLauncherInstallation(launcher)?.executables.toSorted((a, b) => a.path.localeCompare(b.path)),
    executables,
  )
})
