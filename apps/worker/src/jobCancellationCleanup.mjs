import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, verify } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { SignedJobCancellationGrantSchema, SignedJobCancellationClosureSchema,
  JOB_CANCELLATION_GRANT_TTL_MS, jobCancellationGrantMessage,
  jobCancellationClosureMessage } from '../../../packages/contracts/src/jobCancellationRecovery.ts';
import { WorkerPairingConfigurationSchema } from '../../../packages/contracts/src/deviceIdentity.ts';
import { RemoteJobOperationReceiptSchema } from '../../../packages/contracts/src/remoteJobExecution.ts';
import { publicKeyFingerprint } from '../../../packages/contracts/src/deviceIdentityNode.ts';
import { RemoteOperationJournal } from '../../../apps/api/src/modules/runs/remote/operationJournal.ts';
import { releaseMaterializationClaim, preparationChildrenClosed } from '../../../apps/api/src/modules/sources/materialization.ts';
import { sourceBindingHash, sourceMaterializationDigest } from '../../../apps/api/src/modules/sources/bindingHash.ts';
import { anchored, identity as filesystemIdentity, openPrivateRoot,
  openChildDirectory } from '../../../apps/api/src/modules/sources/privateFilesystem.ts';
import { loadApprovedRoots } from './approvedRoots.mjs';
import { acquireWorkerLock } from './runtime.mjs';
import { WorkerError } from './diagnostics.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw new WorkerError(code); };

async function readPrivateBytes(parent, name, maximum = 65536) {
  const file = await open(anchored(parent, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.uid !== process.getuid() || before.mode & 0o077 || before.nlink !== 1
      || before.size < 1 || before.size > maximum) fail('job_cleanup_private_file_required');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) fail('job_cleanup_input_changed');
      offset += result.bytesRead;
    }
    const after = await file.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail('job_cleanup_input_changed');
    return bytes;
  } finally { await file.close(); }
}

function checkGrant(grant, localIdentity, pairing) {
  const { execution, intent, root, materialization, registration } = grant;
  const spec = execution.acceptedSpec;
  const original = { workerInstallationId: pairing.workerInstallationId, keyRevision: pairing.keyRevision,
    authorizationRevision: pairing.authorizationRevision };
  if (localIdentity.formatVersion !== 1 || localIdentity.workerInstallationId !== pairing.workerInstallationId
    || localIdentity.keyRevision !== pairing.keyRevision
    || publicKeyFingerprint(localIdentity.publicKey) !== localIdentity.publicKeyFingerprint
    || publicKeyFingerprint(createPublicKey(createPrivateKey(localIdentity.privateKey))
      .export({ type: 'spki', format: 'pem' }).toString())
      !== localIdentity.publicKeyFingerprint) fail('job_cleanup_identity_invalid');
  if (registration.mainId !== pairing.mainId || registration.deviceId !== pairing.deviceId
    || registration.workerInstallationId !== localIdentity.workerInstallationId
    || registration.keyRevision !== localIdentity.keyRevision
    || registration.publicKeyFingerprint !== localIdentity.publicKeyFingerprint
    || registration.status === 'pending'
    || registration.authorizationRevision < pairing.authorizationRevision) fail('job_cleanup_registration_changed');
  if (spec.target.hostRef.kind !== 'device' || spec.target.hostRef.mainId !== pairing.mainId
    || spec.target.hostRef.deviceId !== pairing.deviceId || spec.target.mainId !== pairing.mainId
    || spec.target.mainInstallationId !== pairing.mainId || !isDeepStrictEqual(spec.target.registration, original)
    || !isDeepStrictEqual(root.registration, original) || !isDeepStrictEqual(root.selection.hostRef, spec.target.hostRef))
    fail('job_cleanup_pairing_changed');
  if (intent.mainId !== pairing.mainId || intent.executionId !== execution.id || intent.operationId !== execution.operationId
    || intent.attemptId !== execution.attemptId || intent.bindingHash !== spec.bindingHash
    || intent.inputDigest !== `sha256:${spec.specDigest}` || intent.subject.workspaceId !== execution.workspaceId
    || !isDeepStrictEqual(intent.owner, execution.owner)) fail('job_cleanup_intent_changed');
  if (materialization.operationId !== intent.operationId || materialization.receipt.executionId !== execution.id
    || materialization.receipt.attemptId !== execution.attemptId
    || materialization.receipt.materializationId !== spec.source.materializationId
    || materialization.receipt.verifiedManifestDigest !== spec.source.manifestDigest
    || sourceMaterializationDigest(materialization) !== spec.source.materializationDigest
    || materialization.sourceBindingHash !== sourceBindingHash(root, materialization.receipt, intent.operationId)
    || materialization.receipt.placementHash !== materialization.sourceBindingHash
    || materialization.finalDispatchBindingHash !== spec.bindingHash
    || materialization.receipt.keyRevision !== pairing.keyRevision
    || materialization.receipt.authorizationRevision !== pairing.authorizationRevision
    || !isDeepStrictEqual(materialization.receipt.binding, root.binding)
    || root.binding.workspaceId !== execution.workspaceId || root.binding.accessMode !== 'exclusive-write'
    || root.selection.rootPolicyId !== spec.target.destination.rootPolicyId
    || root.selection.rootPolicyRevision !== spec.target.destination.rootPolicyRevision
    || root.selection.locationRevision !== spec.target.destination.locationRevision
    || root.binding.snapshotId !== spec.source.snapshotId || root.source.approvedSourceId !== spec.source.approvedSourceId
    || root.source.manifestDigest !== spec.source.manifestDigest) fail('job_cleanup_source_changed');
}

function checkLifetime(grant) {
  const now = Date.now();
  if (Date.parse(grant.approvedAt) > now || Date.parse(grant.expiresAt) <= now
    || Date.parse(grant.expiresAt) - Date.parse(grant.approvedAt) > JOB_CANCELLATION_GRANT_TTL_MS)
    fail('job_cleanup_grant_expired');
}

async function checkSourceRoot(grant, approved) {
  const { root, execution } = grant;
  if (!approved || dirname(root.binding.canonicalPath) !== join(approved.managedRuntimeRoot, 'source-materializations')
    || basename(root.binding.canonicalPath) !== root.selection.rootPolicyId
    || execution.acceptedSpec.target.destination.managedRuntimeRoot !== approved.managedRuntimeRoot)
    fail('job_cleanup_root_not_approved');
  const directory = await openPrivateRoot(root.binding.canonicalPath);
  try {
    if (!isDeepStrictEqual(await filesystemIdentity(directory), root.binding.filesystem))
      fail('job_cleanup_filesystem_changed');
  } finally { await directory.close(); }
}

function matchesReplay(receipt, grant, command, grantDigest) {
  return !receipt.entryAttempted && !receipt.native && receipt.stopFence
    && receipt.terminal?.outcome === 'cancelled' && receipt.terminal.processStopped
    && receipt.terminal.exitCode === null && receipt.terminal.signal === null
    && receipt.terminal.closureEvidenceDigest === grantDigest
    && isDeepStrictEqual(receipt.intent, grant.intent)
    && isDeepStrictEqual(receipt.execution.acceptedSpec, grant.execution.acceptedSpec)
    && receipt.controls.some(control => isDeepStrictEqual(control, command));
}

/** A signed, human-approved stop for one original Job that never entered native execution. */
export async function cleanupJobBeforeEntry(stateDirectory, grantPath) {
  const state = await openPrivateRoot(stateDirectory);
  let unlock;
  let journal;
  try {
    unlock = await acquireWorkerLock(stateDirectory);
    const input = await openPrivateRoot(dirname(grantPath));
    let signed;
    try { signed = SignedJobCancellationGrantSchema.parse(JSON.parse(await readPrivateBytes(input, basename(grantPath)))); }
    finally { await input.close(); }
    const identityBytes = await readPrivateBytes(state, 'identity.json');
    const pairingBytes = await readPrivateBytes(state, 'pairing.json');
    const localIdentity = JSON.parse(identityBytes);
    const pairing = WorkerPairingConfigurationSchema.parse(JSON.parse(pairingBytes));
    if (publicKeyFingerprint(signed.mainPublicKey) !== pairing.mainPublicKeyFingerprint
      || !verify(null, Buffer.from(jobCancellationGrantMessage(signed.grant)), signed.mainPublicKey,
        Buffer.from(signed.signature, 'base64url'))) fail('job_cleanup_main_signature_invalid');
    const grant = signed.grant;
    const authority = async () => {
      checkLifetime(grant);
      checkGrant(grant, localIdentity, pairing);
      if (!(await readPrivateBytes(state, 'identity.json')).equals(identityBytes)
        || !(await readPrivateBytes(state, 'pairing.json')).equals(pairingBytes)) fail('job_cleanup_identity_changed');
      await checkSourceRoot(grant, await loadApprovedRoots(stateDirectory, pairing));
    };
    await authority();
    const journalBytes = await readPrivateBytes(state, 'job-runtime-operations.json', 4 * 1024 * 1024);
    const command = { schemaVersion: 1, protocolVersion: 1, commandId: grant.cancelCommandId,
      operationId: grant.intent.operationId, attemptId: grant.intent.attemptId, executionId: grant.intent.executionId,
      bindingHash: grant.intent.bindingHash, subject: grant.intent.subject, owner: grant.intent.owner, action: { kind: 'stop' } };
    const grantDigest = hash(Buffer.from(jobCancellationGrantMessage(grant)));
    const originalHashMatches = hash(journalBytes) === grant.journalSha256;
    if (!originalHashMatches) {
      const raw = JSON.parse(journalBytes);
      const records = raw.receipts?.filter(receipt => receipt.intent?.operationId === grant.intent.operationId);
      const prior = records?.length === 1 ? RemoteJobOperationReceiptSchema.safeParse(records[0]) : null;
      if (!prior?.success || !matchesReplay(prior.data, grant, command, grantDigest)
        || raw.jobOwners?.some(owner => owner.operationId === grant.intent.operationId))
        fail('job_cleanup_original_journal_required');
    }
    journal = await RemoteOperationJournal.open(join(stateDirectory, 'job-runtime-operations.json'));
    const connection = await journal.jobCancellationConnection(grant.execution);
    const retained = await journal.jobStatus(grant.intent.operationId);
    if (!originalHashMatches) {
      if (retained.status !== 'known' || !matchesReplay(retained.receipt, grant, command, grantDigest)
        || await journal.jobNativeOwner(grant.intent.operationId)) fail('job_cleanup_original_journal_required');
    }
    if (retained.status === 'known' && retained.receipt.terminal
      && retained.receipt.terminal.closureEvidenceDigest !== grantDigest) fail('job_cleanup_terminal_conflict');
    const terminal = retained.status === 'known' && retained.receipt.terminal ? retained.receipt.terminal : {
      finishedAt: new Date().toISOString(), outcome: 'cancelled', exitCode: null, signal: null, processStopped: true,
      closureEvidenceDigest: grantDigest,
      resultDigest: hash(Buffer.from(JSON.stringify({ operationId: grant.intent.operationId, outcome: 'cancelled' }))),
      logGapPossible: false, logsTruncated: false, outputCollectionError: false, artifactDigests: [],
    };
    let receipt = await journal.jobCancelBeforeEntry(grant.intent, grant.execution, connection, randomUUID(), command, terminal);
    const noEntry = async () => {
      await authority();
      const status = await journal.jobStatus(grant.intent.operationId);
      if (status.status !== 'known' || status.receipt.entryAttempted || status.receipt.native
        || !status.receipt.stopFence || status.receipt.terminal?.outcome !== 'cancelled'
        || await journal.jobNativeOwner(grant.intent.operationId)) fail('job_cleanup_native_entry_requires_recovery');
      return await preparationChildrenClosed(grant.root.binding.canonicalPath) ? 'released' : 'uncertain';
    };
    await releaseMaterializationClaim(grant.materialization.receipt, noEntry);
    const root = await openPrivateRoot(grant.root.binding.canonicalPath);
    let archiveBytes;
    try {
      const materialization = await openChildDirectory(root, grant.materialization.receipt.materializationId);
      try { archiveBytes = await readPrivateBytes(materialization, 'released-claim.json', 16384); }
      finally { await materialization.close(); }
    } finally { await root.close(); }
    await authority();
    receipt = await journal.jobPublication(grant.intent.operationId, 'complete');
    const closure = { schemaVersion: 1, grantId: grant.id, receipt, sourceClaim: {
      materializationId: grant.materialization.receipt.materializationId, reservationId: grant.materialization.reservationId,
      released: true, archiveSha256: hash(archiveBytes) } };
    return SignedJobCancellationClosureSchema.parse({ closure,
      signature: sign(null, Buffer.from(jobCancellationClosureMessage(closure)), localIdentity.privateKey).toString('base64url') });
  } finally {
    try { await journal?.close(); }
    finally { try { await unlock?.(); } finally { await state.close(); } }
  }
}
