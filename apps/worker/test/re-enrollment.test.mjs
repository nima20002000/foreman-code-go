import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mockHostMounts, persistentHostMounts } from './fixtures/hostMounts.mjs';
import { acquireWorkerLock } from '../src/runtime.mjs';

const require = createRequire(new URL('../../api/package.json', import.meta.url));
const { tsImport } = await import(require.resolve('tsx/esm/api'));
const { enrollWorkerCode } = await tsImport('../src/enrollment.mjs', import.meta.url);
const { encodeWorkerEnrollmentCode } = await tsImport('../../../packages/contracts/src/deviceSetup.ts', import.meta.url);
const { loadOrCreateWorkerIdentity, persistWorkerPairing, loadWorkerPairing, publicKeyFingerprint,
  mainEnrollmentProofMessage } = await tsImport('../../../packages/contracts/src/deviceIdentityNode.ts', import.meta.url);

async function fixture(t) {
  t.after(mockHostMounts(t.mock, persistentHostMounts));
  const parent = join(homedir(), '.cache', 'foreman-tmp');
  await mkdir(parent, { recursive: true });
  const home = await mkdtemp(join(parent, 'worker-re-enroll-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const stateDirectory = join(home, 'state');
  const identity = await loadOrCreateWorkerIdentity(stateDirectory);
  const key = generateKeyPairSync('ed25519');
  const publicKey = key.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const previous = { formatVersion: 1, mainId: randomUUID(), deviceId: randomUUID(),
    workerInstallationId: identity.workerInstallationId, keyRevision: 1, authorizationRevision: 1,
    endpoint: 'wss://main.example/device/connect', mainPublicKeyFingerprint: publicKeyFingerprint(publicKey),
    credential: 'a'.repeat(64), expiresAt: '2099-01-01T00:00:00.000Z' };
  await persistWorkerPairing(stateDirectory, previous);
  const enrollment = { mainId: previous.mainId, mainPublicKeyFingerprint: previous.mainPublicKeyFingerprint,
    endpoint: previous.endpoint, grant: 'g'.repeat(43), requestId: randomUUID() };
  const code = () => encodeWorkerEnrollmentCode({ version: 1, kind: 'enrollment',
    workerInstallationId: identity.workerInstallationId, publicKeyFingerprint: identity.publicKeyFingerprint,
    enrollment, expiresAt: '2099-01-01T00:00:00.000Z' });
  const registration = { mainId: previous.mainId, deviceId: previous.deviceId,
    workerInstallationId: identity.workerInstallationId, publicKeyFingerprint: identity.publicKeyFingerprint,
    keyRevision: 1, authorizationRevision: 3, status: 'paired', scopes: ['connect', 'heartbeat'] };
  const calls = [];
  const post = async (url, body) => {
    calls.push(url);
    if (url.endsWith('/device/challenge')) return { request: body, mainApplicationVersion: '1.0.0',
      mainPublicKey: publicKey, mainPublicKeyFingerprint: enrollment.mainPublicKeyFingerprint,
      signature: sign(null, Buffer.from(mainEnrollmentProofMessage(body, '1.0.0')), key.privateKey).toString('base64url') };
    return { registration, credential: 'b'.repeat(64), expiresAt: previous.expiresAt };
  };
  const enroll = () => enrollWorkerCode({ stateDirectory, identity, enrollmentCode: code(),
    appVersion: '1.0.0', home, post });
  return { stateDirectory, previous, enrollment, registration, calls, enroll };
}

test('same-Main re-enrollment replaces revoked credentials and refreshes managed runtime bindings', async t => {
  const f = await fixture(t);
  const identity = await readFile(join(f.stateDirectory, 'identity.json'));
  const result = await f.enroll();
  assert.equal(result.authorizationRevision, 3);
  const pairing = await loadWorkerPairing(f.stateDirectory);
  assert.equal(pairing.credential, 'b'.repeat(64));
  assert.equal(pairing.deviceId, f.previous.deviceId);
  const setup = JSON.parse(await readFile(join(f.stateDirectory, 'managed-setup.json'), 'utf8'));
  assert.equal(setup.status.state, 'runtime-unavailable');
  assert.equal(setup.target.registration.authorizationRevision, 3);
  assert.deepEqual(await readFile(join(f.stateDirectory, 'identity.json')), identity);
  assert.deepEqual(await f.enroll(), result);
});

test('re-enrollment cannot switch Main or replace the accepted device identity', async t => {
  const f = await fixture(t);
  f.enrollment.mainId = randomUUID();
  await assert.rejects(f.enroll());
  assert.deepEqual(await loadWorkerPairing(f.stateDirectory), f.previous);
  f.enrollment.mainId = f.previous.mainId;
  f.registration.deviceId = randomUUID();
  await assert.rejects(f.enroll());
  assert.deepEqual(await loadWorkerPairing(f.stateDirectory), f.previous);
  f.registration.deviceId = f.previous.deviceId;
  f.registration.authorizationRevision = 1;
  await assert.rejects(f.enroll());
  assert.deepEqual(await loadWorkerPairing(f.stateDirectory), f.previous);
});

test('re-enrollment waits for the existing Worker to stop before sending the grant', async t => {
  const f = await fixture(t);
  const unlock = await acquireWorkerLock(f.stateDirectory);
  try {
    await assert.rejects(f.enroll(), { code: 'worker_already_running' });
    assert.deepEqual(f.calls, []);
    assert.deepEqual(await loadWorkerPairing(f.stateDirectory), f.previous);
  } finally { await unlock(); }
});
