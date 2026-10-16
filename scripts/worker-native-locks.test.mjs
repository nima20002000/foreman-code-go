import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import test from 'node:test'
import * as policy from './worker-snapshot-policy.mjs'

const root = resolve(import.meta.dirname, '..')
const { build } = createRequire(join(root, 'apps/worker/package.json'))('esbuild')

test('bundled Worker directory locks load their native binding and preserve exclusion', async t => {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const directory = await mkdtemp(join(cache, 'worker-native-lock-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const entry = join(directory, 'entry.mjs')
  const lockModule = join(root, 'apps/api/src/modules/sources/privateFilesystem.ts')
  await writeFile(entry, `
    import { withPrivateDirectoryLock } from ${JSON.stringify(lockModule)};
    import { open } from 'node:fs/promises';
    export async function check(path) {
      const first = await open(path, 'r');
      const second = await open(path, 'r');
      try {
        const excluded = await withPrivateDirectoryLock(first, async () => {
          try {
            await withPrivateDirectoryLock(second, async () => true, {nonBlocking: true});
            return false;
          } catch (error) { return error.code === 'SOURCE_CLAIM_LOCK_FAILED'; }
        });
        return excluded && await withPrivateDirectoryLock(second, async () => true, {nonBlocking: true});
      } finally { await first.close(); await second.close(); }
    }
  `)
  const output = join(directory, 'bundle.mjs')
  await build({ entryPoints: [entry], outfile: output,
    bundle: true, platform: 'node', format: 'esm', metafile: true,
    loader: policy.workerNativeLoaders,
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  })
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e',
    `import cp from 'node:child_process';
     import { syncBuiltinESMExports } from 'node:module';
     let spawns = 0;
     const original = cp.spawn;
     cp.spawn = (...args) => { spawns++; return original(...args); };
     syncBuiltinESMExports();
     const { check } = await import(${JSON.stringify(output)});
     console.log(await check(${JSON.stringify(directory)}), spawns);`])
  assert.equal(stdout.trim(), 'true 0')
})
