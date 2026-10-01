import { randomBytes, sign } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { WorkerEnrollmentInputSchema, DevicePairingResultSchema } from '../../../packages/contracts/src/deviceIdentity.ts';
import { pairingProof, verifyMainEnrollmentProof, persistWorkerPairing } from '../../../packages/contracts/src/deviceIdentityNode.ts';
import { WorkerError } from './diagnostics.mjs';

export async function boundedPost(url, body, fetchRequest = fetch) {
  const response = await fetchRequest(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(10_000) });
  if (!response.ok || !response.body) throw new WorkerError('enrollment_rejected');
  let size = 0; const chunks = [];
  const reader = response.body.getReader();
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.length;
      if (size > 16_384) throw new WorkerError('enrollment_response_too_large');
      chunks.push(Buffer.from(next.value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function enrollWorker({ stateDirectory, identity, enrollmentFile, appVersion, post = boundedPost }) {
  const file = await lstat(enrollmentFile);
  if (!file.isFile() || file.uid !== process.getuid() || (file.mode & 0o077) || file.size > 16_384) throw new WorkerError('private_enrollment_file_required');
  const enrollment = WorkerEnrollmentInputSchema.parse(JSON.parse(await readFile(enrollmentFile, 'utf8')));
  const endpoint = new URL(enrollment.endpoint);
  if (endpoint.protocol !== 'wss:' || endpoint.username || endpoint.password || endpoint.pathname !== '/device/connect' || endpoint.search || endpoint.hash) throw new WorkerError('enrollment_endpoint_invalid');
  const http = new URL(endpoint); http.protocol = 'https:';
  const proofRequest = { audience: 'graphql-worker-main-enrollment-v1', mainId: enrollment.mainId, workerInstallationId: identity.workerInstallationId, nonce: randomBytes(32).toString('base64url'), protocolVersion: 1, workerApplicationVersion: appVersion };
  http.pathname = '/device/challenge';
  const proof = await post(http.href, proofRequest);
  if (!await verifyMainEnrollmentProof(proof, proofRequest, enrollment.mainPublicKeyFingerprint)) throw new WorkerError('wrong_main_proof');
  // Grant and signed enrollment are sent only after a fresh pinned-key proof.
  const request = { mainId: enrollment.mainId, workerInstallationId: identity.workerInstallationId, publicKey: identity.publicKey, grant: enrollment.grant, requestId: enrollment.requestId };
  const signature = sign(null, Buffer.from(pairingProof(request)), identity.privateKey).toString('base64url');
  http.pathname = '/device/pair';
  const result = DevicePairingResultSchema.parse(await post(http.href, { ...request, signature }));
  if (result.registration.mainId !== enrollment.mainId || result.registration.workerInstallationId !== identity.workerInstallationId || result.registration.publicKeyFingerprint !== identity.publicKeyFingerprint || result.registration.keyRevision !== identity.keyRevision || result.registration.status !== 'paired') throw new WorkerError('enrollment_identity_mismatch');
  await persistWorkerPairing(stateDirectory, { formatVersion: 1, mainId: result.registration.mainId, deviceId: result.registration.deviceId, workerInstallationId: identity.workerInstallationId, keyRevision: result.registration.keyRevision, authorizationRevision: result.registration.authorizationRevision, endpoint: enrollment.endpoint, mainPublicKeyFingerprint: enrollment.mainPublicKeyFingerprint, credential: result.credential, expiresAt: result.expiresAt });
  return { mainId: result.registration.mainId, deviceId: result.registration.deviceId, workerInstallationId: identity.workerInstallationId, authorizationRevision: result.registration.authorizationRevision };
}
