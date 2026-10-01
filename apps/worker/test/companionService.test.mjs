import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { installVersion } from '../src/installation.mjs';
import { createCompanionService } from '../src/companionService.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'companion-service-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = join(home, '.local/lib/graphql-worker'), state = join(home, '.local/state/graphql-worker'), artifact = join(home, 'artifact');
  await mkdir(state, { recursive: true, mode: 0o700 });
  const files = [{ path: 'src/cli.mjs', bytes: Buffer.from('fixture-only') }, { path: 'artifacts/graphql-worker.service.in', bytes: await readFile(new URL('../artifacts/graphql-worker.service.in', import.meta.url)) }];
  for (const file of files) { await mkdir(join(artifact, file.path, '..'), { recursive: true }); await writeFile(join(artifact, file.path), file.bytes); }
  const facts = { os: 'ubuntu', osRelease: '24.04', arch: 'x64', libc: 'glibc-2.39', node: 'v22.17.1', rootPersistent: true, homePersistent: true, storagePersistent: true };
  const manifest = { format: 1, version: '1.0.0', protocolVersion: 1, identityFormat: 1, commit: 'a'.repeat(40), lockfileSha256: 'b'.repeat(64), packageManager: 'pnpm@11.27.0', target: facts, files: files.map(({ path, bytes }) => ({ path, sha256: hash(bytes), size: bytes.length })) };
  const bytes = JSON.stringify(manifest); await writeFile(join(artifact, 'manifest.json'), bytes);
  await installVersion({ root, artifact, facts, approvedManifestSha256: hash(bytes), expected: { protocolVersion: 1, identityFormat: 1 } });
  const calls = [];
  const service = createCompanionService({ home, stateDirectory: state, factsProvider: async () => facts, executeSystemctl: async (binary, args) => { calls.push({ binary, args }); } });
  return { home, root, state, service, calls };
}

test('service preview is inert; enabling requires its exact verified plan and only invokes owned user-service commands', async (t) => {
  const f = await fixture(t), plan = await f.service.plan();
  assert.deepEqual(f.calls, []);
  await assert.rejects(readFile(plan.unitPath), { code: 'ENOENT' });
  await assert.rejects(f.service.enable('a'.repeat(64)), /service_plan_changed/);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await f.service.enable(plan.planSha256), { enabled: true });
  assert.equal((await stat(plan.unitPath)).mode & 0o777, 0o600);
  assert.equal(await readFile(plan.unitPath, 'utf8'), plan.unitText);
  assert.deepEqual(f.calls, [
    { binary: '/usr/bin/systemctl', args: ['--user', 'show', '--property=Version'] },
    { binary: '/usr/bin/systemctl', args: ['--user', 'daemon-reload'] },
    { binary: '/usr/bin/systemctl', args: ['--user', 'enable', '--now', 'graphql-worker.service'] },
  ]);
  assert.equal(plan.lingerAction, 'none');
});

test('tampered installed template cannot become a user service', async (t) => {
  const f = await fixture(t), plan = await f.service.plan();
  await writeFile(join(f.root, 'current/artifacts/graphql-worker.service.in'), '[Service]\nExecStart=/unapproved\n');
  await assert.rejects(f.service.enable(plan.planSha256), /artifact_checksum_mismatch/);
  assert.deepEqual(f.calls, []);
  await assert.rejects(readFile(plan.unitPath), { code: 'ENOENT' });
});
