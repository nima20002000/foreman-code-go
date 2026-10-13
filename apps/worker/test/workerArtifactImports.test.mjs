import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const repository = fileURLToPath(new URL('../../../', import.meta.url));

async function fixture(t) {
  const cache = join(homedir(), '.cache/foreman-tmp');
  await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(join(cache, 'worker-imports-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'repository');
  const environment = {
    ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  };
  execFileSync('git', ['clone', '--quiet', '--shared', repository, root], { env: environment });
  for (const path of ['node_modules', 'apps/worker/node_modules', 'apps/api/node_modules',
    'packages/contracts/node_modules']) {
    await symlink(join(repository, path), join(root, path));
  }
  const write = async (path, source) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), source);
  };
  const build = () => {
    const git = args => execFileSync('git', args, { cwd: root, env: environment, encoding: 'utf8' });
    git(['add', '.']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'Worker imports']);
    const commit = git(['rev-parse', 'HEAD']).trim();
    return spawnSync(process.execPath, [join(root, 'scripts/build-worker-artifact.mjs'),
      'apps/worker/artifacts/ubuntu-26.04-x64-target.json', join(directory, 'release')], {
      cwd: root, encoding: 'utf8', timeout: 120_000,
      env: { ...environment, FOREMAN_CODE_WORKER_BUILD_COMMIT: commit, GRAPHQL_WORKER_BUILD_COMMIT: commit },
    });
  };
  return { root, directory, write, build };
}

test('Worker artifacts bundle new transitive API helpers without registering modules', async t => {
  const f = await fixture(t);
  await f.write('apps/api/src/modules/worker-build-fixture/value.ts',
    "export const value = 'bundled from the import graph';\n");
  await f.write('apps/api/src/modules/worker-build-fixture/helper.ts',
    "import { value } from './value.js';\nexport const importedHelper = () => value;\n");
  await appendFile(join(f.root, 'apps/worker/src/workerFactory.mjs'),
    "\nexport { importedHelper } from '../../api/src/modules/worker-build-fixture/helper.ts';\n");
  const result = f.build();
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const worker = await import(pathToFileURL(join(f.directory, 'release/src/worker.mjs')).href);
  assert.equal(worker.importedHelper(), 'bundled from the import graph');
});

test('Worker artifacts reject forbidden modules, sensitive files and imports outside source scope', async t => {
  const forbidden = [
    'apps/api/src/server.ts', 'apps/api/src/app.ts', 'apps/api/src/production.ts',
    'apps/api/src/infrastructure/db.ts', 'apps/api/src/infrastructure/database.ts',
    'apps/api/src/db/fixture.ts', 'apps/api/src/migrations/fixture.ts', 'apps/api/src/bootstrap/fixture.ts',
    'apps/api/src/modules/worker-build-fixture/credentials.json',
    'apps/api/src/modules/worker-build-fixture/.env.json',
    'apps/api/src/modules/worker-build-fixture/fixture.test.ts', 'apps/api/fixture.ts',
  ];
  for (const path of forbidden) {
    await t.test(path, async t => {
      const f = await fixture(t);
      await f.write(path, path.endsWith('.json') ? '{"value":"fixture"}\n' : 'export const value = 1;\n');
      await f.write('apps/worker/src/workerFactory.mjs',
        `import '../../${path.slice('apps/'.length)}';\nexport const worker = true;\n`);
      const result = f.build();
      assert.ifError(result.error);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Forbidden snapshot source:/);
    });
  }
});
