import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
const require = createRequire(new URL('../../api/package.json', import.meta.url));
const { tsImport } = await import(require.resolve('tsx/esm/api'));
const { enrollWorker, boundedPost } = await tsImport('../src/enrollment.mjs', import.meta.url);
const { loadOrCreateWorkerIdentity, publicKeyFingerprint, mainEnrollmentProofMessage, mainIdentityProofMessage, pairingProof } = await tsImport('../../../packages/contracts/src/deviceIdentityNode.ts', import.meta.url);

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'worker-enroll-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const identity = await loadOrCreateWorkerIdentity(directory);
  const key = generateKeyPairSync('ed25519');
  const publicKey = key.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const input = { mainId: randomUUID(), mainPublicKeyFingerprint: publicKeyFingerprint(publicKey), endpoint: 'wss://main.example/device/connect', grant: 'a'.repeat(43), requestId: randomUUID() };
  const enrollmentFile = join(directory, 'enrollment.json');
  await writeFile(enrollmentFile, JSON.stringify(input), { mode: 0o600 });
  return { stateDirectory: directory, identity, enrollmentFile, appVersion: '0.1.0', input, key, publicKey };
}

test('fresh selected-main proof precedes grant; persisted credential never enters CLI result', async (t) => {
  const f = await fixture(t); const calls = [];
  const result = await enrollWorker({ ...f, post: async (url, body) => {
    calls.push(url);
    if (url.endsWith('/device/challenge')) {
      assert.equal(body.grant, undefined);
      return { request: body, mainApplicationVersion: '0.1.0', mainPublicKey: f.publicKey, mainPublicKeyFingerprint: f.input.mainPublicKeyFingerprint, signature: sign(null, Buffer.from(mainEnrollmentProofMessage(body, '0.1.0')), f.key.privateKey).toString('base64url') };
    }
    assert.equal(verify(null, Buffer.from(pairingProof(body)), f.identity.publicKey, Buffer.from(body.signature, 'base64url')), true);
    return { registration: { mainId: f.input.mainId, deviceId: randomUUID(), workerInstallationId: f.identity.workerInstallationId, publicKeyFingerprint: f.identity.publicKeyFingerprint, keyRevision: 1, authorizationRevision: 1, status: 'paired', scopes: ['connect', 'heartbeat'] }, credential: 'b'.repeat(64), expiresAt: '2026-12-01T00:00:00.000Z' };
  } });
  assert.deepEqual(calls, ['https://main.example/device/challenge', 'https://main.example/device/pair']);
  assert.equal(JSON.stringify(result).includes('b'.repeat(64)), false);
  const persisted = JSON.parse(await readFile(join(f.stateDirectory, 'pairing.json'), 'utf8'));
  assert.equal(persisted.mainPublicKeyFingerprint, f.input.mainPublicKeyFingerprint);
  assert.equal(persisted.credential, 'b'.repeat(64));
});

test('forged main proof blocks before sending grant or persisting pairing', async (t) => {
  const f = await fixture(t); let calls = 0;
  await assert.rejects(enrollWorker({ ...f, post: async () => { calls++; return {}; } }), /wrong_main_proof/);
  assert.equal(calls, 1);
  await assert.rejects(readFile(join(f.stateDirectory, 'pairing.json')), { code: 'ENOENT' });
});

test('connection-purpose proof cannot authorize enrollment or release its grant', async (t) => {
  const f = await fixture(t); let calls = 0;
  await assert.rejects(enrollWorker({ ...f, post: async (_url, body) => {
    calls++;
    const request = { ...body, audience: 'graphql-worker-main-v1' };
    return { request, mainApplicationVersion: '0.1.0', mainPublicKey: f.publicKey, mainPublicKeyFingerprint: f.input.mainPublicKeyFingerprint, signature: sign(null, Buffer.from(mainIdentityProofMessage(request, '0.1.0')), f.key.privateKey).toString('base64url') };
  } }), /wrong_main_proof/);
  assert.equal(calls, 1);
  await assert.rejects(readFile(join(f.stateDirectory, 'pairing.json')), { code: 'ENOENT' });
});

test('bounded enrollment response rejects overflow and HTTP failure', async () => {
  await assert.rejects(boundedPost('https://main.example', {}, async () => new Response('a'.repeat(16_385))), /enrollment_response_too_large/);
  await assert.rejects(boundedPost('https://main.example', {}, async () => new Response('{}', { status: 401 })), /enrollment_rejected/);
});
