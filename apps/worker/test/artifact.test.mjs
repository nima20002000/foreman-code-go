import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

const artifact = process.env.GRAPHQL_WORKER_ARTIFACT_DIRECTORY;
test('built worker factory accepts supplied real registration and rejects placeholder servers', { skip: !artifact }, async () => {
  const { createWorkerConnection } = await import(pathToFileURL(join(artifact, 'src/worker.mjs')).href);
  const pairing = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1, endpoint: 'wss://package-check.example/device/connect', credential: 'a'.repeat(64), mainPublicKeyFingerprint: 'b'.repeat(64) };
  const registration = { namespace: 'package-check-v1', version: 1, role: 'duplex', maxJsonBytes: 1024, maxBinaryBytes: 1024, handle: async (payload, context) => ({ payload, bytes: context.bytes }) };
  const connection = createWorkerConnection({ pairing, bootId: randomUUID(), appVersion: '0.1.0', extensions: [registration] });
  assert.equal(connection.status().phase, 'disconnected');
  assert.deepEqual(connection.capabilities(), []);
  await assert.rejects(connection.request(registration.namespace, { probe: true }), /unavailable/);
  await connection.stop();
  assert.throws(() => createWorkerConnection({ pairing, bootId: randomUUID(), appVersion: '0.1.0', extensions: [{ ...registration, handle: undefined }] }), /actual domain handler/);
});

test('packaged bytes match manifest and doctor import creates no worker authority', { skip: !artifact }, async (t) => {
  const manifest = JSON.parse(await readFile(join(artifact, 'manifest.json'), 'utf8'));
  assert.ok(manifest.files.some((file) => file.path === 'src/worker.mjs'));
  for (const file of manifest.files) assert.equal(createHash('sha256').update(await readFile(join(artifact, file.path))).digest('hex'), file.sha256);
  const state = await mkdtemp(join(tmpdir(), 'worker-artifact-probe-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const result = JSON.parse(execFileSync(process.execPath, [join(artifact, 'src/cli.mjs'), 'doctor', '--state', state], { encoding: 'utf8', timeout: 5000 }));
  assert.equal(result.versions.commit, manifest.commit);
  assert.equal(result.versions.lockfileSha256, manifest.lockfileSha256);
  assert.equal(result.service.active, false);
  assert.equal(result.pairing, 'unpaired');
  await assert.rejects(readFile(join(state, 'identity.json')), { code: 'ENOENT' });
  // This test's tmpfs root is intentionally unqualified; it is not a laptop boot test.
  assert.equal(result.persistentState, false);
  const run = spawnSync(process.execPath, [join(artifact, 'src/cli.mjs'), 'run', '--state', state], { encoding: 'utf8', timeout: 5000 });
  assert.equal(run.status, 1);
  assert.equal(run.stderr.trim(), 'nonpersistent_storage');
  await assert.rejects(readFile(join(state, 'identity.json')), { code: 'ENOENT' });
});
