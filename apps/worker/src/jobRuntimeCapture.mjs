import { constants } from 'node:fs';
import { open, lstat, link, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createPublicKey, randomUUID } from 'node:crypto';
import { WorkerPairingConfigurationSchema } from '../../../packages/contracts/src/deviceIdentity.ts';
import { publicKeyFingerprint } from '../../../packages/contracts/src/deviceIdentityNode.ts';
import { InstalledJobRuntimeCaptureInputRecordSchema, InstalledJobRuntimeConfigurationRecordSchema, captureInstalledRuntimeConfigurationRecord } from '../../../apps/api/src/modules/jobs/installedRuntimeHost.ts';
import { openPrivateRoot, anchored } from '../../../apps/api/src/modules/sources/privateFilesystem.ts';
import { hostFacts, WorkerError } from './diagnostics.mjs';
import { acquireWorkerLock } from './runtime.mjs';
import { loadApprovedRoots } from './approvedRoots.mjs';

async function readPrivateJson(parent, name, maximumBytes = 65536) {
  const file = await open(anchored(parent, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.uid !== process.getuid() || before.mode & 0o077 || before.nlink !== 1 || before.size < 1 || before.size > maximumBytes) throw new WorkerError('job_runtime_private_input_required');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) throw new WorkerError('job_runtime_input_changed');
      offset += read.bytesRead;
    }
    const after = await file.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new WorkerError('job_runtime_input_changed');
    const value = JSON.parse(bytes.toString('utf8'));
    if (maximumBytes > 65536 && value.schemaVersion !== 2 && before.size > 65536) {
      throw new WorkerError('job_runtime_private_input_required');
    }
    return value;
  } finally { await file.close(); }
}

/** Human-reviewed installer configuration only. No identity creation, journal initialization,
 * qualification, execution, or caller-selected overwrite path. */
export async function captureJobRuntime(stateDirectory, inputPath) {
  const facts = await hostFacts(process.env.HOME ?? '', [stateDirectory]);
  if (!facts.rootPersistent || !facts.homePersistent || !facts.storagePersistent) throw new WorkerError('nonpersistent_storage');
  const state = await openPrivateRoot(stateDirectory);
  let unlock;
  try {
    unlock = await acquireWorkerLock(stateDirectory);
    const output = anchored(state, 'job-runtime.json');
    if (await lstat(output).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) throw new WorkerError('job_runtime_configuration_exists');
    const identity = await readPrivateJson(state, 'identity.json');
    const pairing = WorkerPairingConfigurationSchema.parse(await readPrivateJson(state, 'pairing.json'));
    if (identity.formatVersion !== 1 || identity.workerInstallationId !== pairing.workerInstallationId || identity.keyRevision !== pairing.keyRevision
      || publicKeyFingerprint(identity.publicKey) !== identity.publicKeyFingerprint
      || publicKeyFingerprint(createPublicKey(identity.privateKey).export({ type: 'spki', format: 'pem' }).toString()) !== identity.publicKeyFingerprint) throw new WorkerError('identity_invalid');
    const inputParent = await openPrivateRoot(dirname(inputPath), false);
    let input;
    try { input = InstalledJobRuntimeCaptureInputRecordSchema.parse(await readPrivateJson(inputParent, basename(inputPath), 2 * 1024 * 1024 + 65536)); }
    finally { await inputParent.close(); }
    const target = input.schemaVersion === 2 ? input.descriptor.target : input.target;
    const runtimeRoot = input.schemaVersion === 2 ? input.descriptor.runtimeRoot : input.runtimeRoot;
    if (target.hostRef.kind !== 'device' || target.hostRef.mainId !== pairing.mainId || target.hostRef.deviceId !== pairing.deviceId
      || target.mainInstallationId !== pairing.mainId || target.registration?.workerInstallationId !== pairing.workerInstallationId
      || target.registration.keyRevision !== pairing.keyRevision || target.registration.authorizationRevision !== pairing.authorizationRevision) throw new WorkerError('job_runtime_identity_mismatch');
    const approved = await loadApprovedRoots(stateDirectory, pairing);
    if (!approved) throw new WorkerError('job_runtime_root_unavailable');
    const policyId = input.root.selection.rootPolicyId;
    if (basename(policyId) !== policyId || policyId === '.' || policyId === '..'
      || runtimeRoot !== approved.managedRuntimeRoot
      || input.root.binding.canonicalPath !== join(approved.managedRuntimeRoot, 'source-materializations', policyId)
      || input.root.binding.filesystem.device !== approved.runtimeFilesystem.device
      || input.root.binding.filesystem.mountId !== approved.runtimeFilesystem.mountId) throw new WorkerError('job_runtime_root_mismatch');
    const configuration = InstalledJobRuntimeConfigurationRecordSchema.parse(await captureInstalledRuntimeConfigurationRecord(input));
    const bytes = Buffer.from(`${JSON.stringify(configuration)}\n`);
    if (bytes.length > (configuration.schemaVersion === 2 ? 2 * 1024 * 1024 + 65536 : 65536)) throw new WorkerError('job_runtime_configuration_too_large');
    const temporary = anchored(state, `.job-runtime-${randomUUID()}`);
    const staged = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      try { await staged.chmod(0o600); await staged.writeFile(bytes); await staged.sync(); } finally { await staged.close(); }
      try { await link(temporary, output); }
      catch (error) { if (error.code === 'EEXIST') throw new WorkerError('job_runtime_configuration_exists'); throw error; }
      await state.sync();
    } finally { await unlink(temporary); }
    await state.sync();
    return { configurationPath: join(stateDirectory, 'job-runtime.json'), captured: true, qualified: false, executionAuthorized: false };
  } catch (error) {
    if (error instanceof WorkerError) throw error;
    throw new WorkerError('job_runtime_capture_failed');
  } finally { try { await unlock?.(); } finally { await state.close(); } }
}
