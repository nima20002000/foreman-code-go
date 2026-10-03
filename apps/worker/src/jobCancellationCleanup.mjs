import { constants } from 'node:fs';
import { open, readFile, realpath } from 'node:fs/promises';
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
import { releaseMaterializationClaim, releaseMaterializationClaimForCancellation,
  preparationChildrenClosed } from '../../../apps/api/src/modules/sources/materialization.ts';
import { InstalledJobRuntimeConfigurationSchema } from '../../../apps/api/src/modules/jobs/installedRuntimeHost.ts';
import { ApprovedRootAllowlistSchema } from '../../../packages/contracts/src/workspaceRootPolicies.ts';
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
    const expected = grant.filesystemRecovery?.filesystem ?? root.binding.filesystem;
    if (expected.inode !== root.binding.filesystem.inode
      || !isDeepStrictEqual(await filesystemIdentity(directory), expected))
      fail('job_cleanup_filesystem_changed');
  } finally { await directory.close(); }
}

/** Validate passive kernel/image observations; no historical filesystem UUID is inferred. */
export function validateRestoredJobFilesystem(context, configuration, observed) {
  if (observed.bootId !== context.bootId || observed.filesystem.inode !== configuration.root.binding.filesystem.inode
    || !isDeepStrictEqual(observed.filesystem, context.filesystem)) fail('job_cleanup_filesystem_changed');
  const matches = observed.mountinfo.split('\n').filter(line => line.split(' ')[0] === context.filesystem.mountId);
  if (matches.length !== 1) fail('job_cleanup_mount_changed');
  const [mount, filesystem] = matches[0].split(' - ');
  const device = mount.split(' ')[2];
  const [type, source] = filesystem?.split(' ') ?? [];
  if (!/^7:\d+$/.test(device ?? '') || type !== 'ext4' || source !== `/dev/loop${device.slice(2)}`)
    fail('job_cleanup_original_volume_required');
  if (observed.backingPath !== configuration.backingFile || observed.backingPath !== context.backingFile.path
    || observed.loopBackingPath !== observed.backingPath || observed.loopOffset !== '0' || observed.loopSizeLimit !== '0')
    fail('job_cleanup_backing_file_changed');
  const backing = observed.backingStat;
  if (!backing.regular || backing.ownerUid !== 0 || backing.mode & 0o222 || backing.links !== 1
    || backing.device !== context.backingFile.device || backing.inode !== context.backingFile.inode
    || backing.bytes !== context.backingFile.bytes || backing.bytes !== String(configuration.pins.diskBytes))
    fail('job_cleanup_backing_file_changed');
  const superblock = observed.superblock;
  if (superblock.length !== 1024 || superblock.readUInt16LE(56) !== 0xef53) fail('job_cleanup_original_volume_required');
  const hex = superblock.subarray(104, 120).toString('hex');
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  if (uuid !== context.filesystemUuid.toLowerCase()) fail('job_cleanup_filesystem_uuid_changed');
  return device;
}

async function verifyRestoredVolume(state, grant, approved) {
  const configuration = InstalledJobRuntimeConfigurationSchema.parse(JSON.parse(await readPrivateBytes(state, 'job-runtime.json')));
  if (!isDeepStrictEqual(configuration.root, grant.root)
    || configuration.runtimeRoot !== approved.managedRuntimeRoot) fail('job_cleanup_runtime_configuration_changed');
  const runtime = await openPrivateRoot(approved.managedRuntimeRoot);
  const namespace = await openPrivateRoot(grant.root.binding.canonicalPath);
  try {
    const current = await filesystemIdentity(namespace);
    const currentRuntime = await filesystemIdentity(runtime);
    if (currentRuntime.inode !== approved.runtimeFilesystem.inode || currentRuntime.device !== current.device
      || currentRuntime.mountId !== current.mountId) fail('job_cleanup_runtime_directory_changed');
    const mountinfo = await readFile('/proc/self/mountinfo', 'utf8');
    const mount = mountinfo.split('\n').filter(line => line.split(' ')[0] === current.mountId);
    if (mount.length !== 1 || !/^7:\d+$/.test(mount[0].split(' ')[2] ?? '')) fail('job_cleanup_original_volume_required');
    const device = mount[0].split(' ')[2];
    const loop = `/sys/dev/block/${device}/loop`;
    const [loopBacking, loopOffset, loopSizeLimit, bootId] = await Promise.all([
      readFile(`${loop}/backing_file`, 'utf8'), readFile(`${loop}/offset`, 'utf8'),
      readFile(`${loop}/sizelimit`, 'utf8'), readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
    ]);
    const backingPath = await realpath(configuration.backingFile);
    if (backingPath !== configuration.backingFile) fail('job_cleanup_backing_file_changed');
    const file = await open(backingPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await file.stat({ bigint: true });
      const superblock = Buffer.alloc(1024);
      const { bytesRead } = await file.read(superblock, 0, superblock.length, 1024);
      const after = await file.stat({ bigint: true });
      if (bytesRead !== superblock.length || before.dev !== after.dev || before.ino !== after.ino
        || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs)
        fail('job_cleanup_backing_file_changed');
      validateRestoredJobFilesystem(grant.filesystemRecovery, configuration, {
        bootId: bootId.trim(), filesystem: current, mountinfo, backingPath,
        loopBackingPath: loopBacking.trim(), loopOffset: loopOffset.trim(), loopSizeLimit: loopSizeLimit.trim(),
        backingStat: { regular: before.isFile(), ownerUid: Number(before.uid), mode: Number(before.mode),
          links: Number(before.nlink), device: before.dev.toString(), inode: before.ino.toString(), bytes: before.size.toString() },
        superblock,
      });
    } finally { await file.close(); }
  } finally { await namespace.close(); await runtime.close(); }
}

async function approvedRootsForCleanup(state, stateDirectory, grant, pairing) {
  if (!grant.filesystemRecovery) return loadApprovedRoots(stateDirectory, pairing);
  const approved = ApprovedRootAllowlistSchema.parse(JSON.parse(await readPrivateBytes(state, 'approved-roots.json', 131072)));
  if (approved.hostRef.kind !== 'device' || approved.hostRef.mainId !== pairing.mainId
    || approved.hostRef.deviceId !== pairing.deviceId || approved.applicationInstallationId !== pairing.workerInstallationId)
    fail('job_cleanup_pairing_changed');
  await checkSourceRoot(grant, approved);
  await verifyRestoredVolume(state, grant, approved);
  return approved;
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
      await checkSourceRoot(grant, await approvedRootsForCleanup(state, stateDirectory, grant, pairing));
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
    if (grant.filesystemRecovery) {
      await releaseMaterializationClaimForCancellation(grant.materialization.receipt, grant.filesystemRecovery.filesystem, noEntry);
    } else await releaseMaterializationClaim(grant.materialization.receipt, noEntry);
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
