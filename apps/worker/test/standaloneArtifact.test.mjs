import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { WorkerArtifactManifestSchema } from '@foreman-code/contracts/worker-update';
import { persistentFixtureRoot } from './fixtureStorage.mjs';

test('the built standalone artifact meets manifest bounds and loads installer help with its shipped modules', async t => {
  const directory = await mkdtemp(join(persistentFixtureRoot, 'standalone-artifact-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = new URL('../../../', import.meta.url).pathname;
  const output = join(directory, 'release');
  execFileSync(process.execPath, ['scripts/build-worker-artifact.mjs',
    'apps/worker/artifacts/test-hosts/ubuntu-24.04-x64-target.json', output],
  { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const manifest = WorkerArtifactManifestSchema.parse(JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8')));
  assert.ok(manifest.files.every(file => !file.path.includes('/claude-agent-sdk-')));
  for (const name of ['cli.mjs', 'install-cli.mjs']) {
    const result = spawnSync(process.execPath, [join(output, 'src', name), '--help'], {
      encoding: 'utf8', timeout: 5000, env: { PATH: '', HOME: '/missing/home' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /install --root \/private\/app --state \/private\/state --artifact/);
  }
});
