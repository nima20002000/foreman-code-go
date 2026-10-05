import { RemoteOperationJournal } from '../../../apps/api/src/modules/runs/remote/operationJournal.ts';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInstalledWorkerDomains } from '../../../apps/api/src/modules/devices/installedWorkerDomains.ts';
import { codexQualificationSuite } from '../../../apps/api/src/modules/harnesses/qualification/suites/codex.ts';
import { qualificationRevisionWithIdentity } from '../../../apps/api/src/modules/harnesses/qualification/identity.ts';
import { loadApprovedRoots } from './approvedRoots.mjs';
import { createWorkerExecutionDomains } from '../../../apps/api/src/modules/runs/remote/workerComposition.ts';
import { mkdir, readFile } from 'node:fs/promises';
import { loadOrCreateWorkerIdentity, loadWorkerPairing } from '../../../packages/contracts/src/deviceIdentityNode.ts';
import { createWorkerConnection } from '../../../apps/api/src/modules/devices/workerConnection.ts';
import { hostFacts, requirePrivateDirectory, WorkerError } from './diagnostics.mjs';
import { validateManifest } from './installation.mjs';
import { startWorker, acquireWorkerLock } from './runtime.mjs';
import { approvedRootExtensions } from './rootExtension.mjs';
import { fileURLToPath } from 'node:url';
import { loadWorkerRsyncEntrypoint } from '../../../apps/api/src/modules/byte-transfer/installedEntrypoints.ts';

export { createWorkerConnection };
export { approvedRootExtensions, createWorkerExecutionDomains };
// Read-only qualification helper for the explicit human installation gate only.
// Startup consumes and verifies the approved facts; it never calls this helper.
export { qualifyApprovedRootAllowlist } from '../../../apps/api/src/modules/sources/rootAttestation.ts';
export { captureInstalledRuntimeConfiguration, captureInstalledRuntimeConfigurationRecord } from '../../../apps/api/src/modules/jobs/installedRuntimeHost.ts';

export async function prepareWorkerState(stateDirectory) {
  const facts = await hostFacts(process.env.HOME ?? '', [stateDirectory]);
  if (!facts.rootPersistent || !facts.homePersistent || !facts.storagePersistent) throw new WorkerError('nonpersistent_storage');
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  validateManifest(manifest, facts, { protocolVersion: 1, identityFormat: 1 });
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await requirePrivateDirectory(stateDirectory);
  return manifest;
}

// Explicit installer action: never recreate a missing established journal on boot.
export async function initializeInstalledNativeRuntime(stateDirectory) {
  await prepareWorkerState(stateDirectory);
  const unlock = await acquireWorkerLock(stateDirectory);
  try {
    const journals = ['workflow-operations.json', 'job-runtime-operations.json'];
    for (const name of journals) {
      const existing = await lstat(join(stateDirectory, name)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (existing) throw new WorkerError('native_runtime_already_initialized');
    }
    for (const name of ['workflow-native-processes', 'job-runtime-native-processes']) {
      const originalRegistry = await lstat(join(stateDirectory, name)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (originalRegistry) throw new WorkerError('native_runtime_recovery_required');
    }
    for (const name of journals) {
      const journal = await RemoteOperationJournal.open(join(stateDirectory, name), { initializeNewInstallation: true });
      await journal.close();
    }
  } finally { await unlock(); }
}

// Only supplied, actual domain registrations enter the authenticated transport.
// The package never manufactures dispatch handlers or another workflow authority.
export async function startConfiguredWorker({ stateDirectory, extensions = [], executionDomains, rsync }) {
  const manifest = await prepareWorkerState(stateDirectory);
  const execution = executionDomains ? createWorkerExecutionDomains(executionDomains) : undefined;
  let installed, connection, rsyncEntrypoint;
  const bindingDrains = new Set();
  const bindingFailures = [];
  const bindingLost = binding => {
    let task;
    try { task = Promise.allSettled([installed?.rsyncWriters?.bindingLost(binding)]).then(results => {
      const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, 'Worker binding loss remains incomplete.');
    }); }
    catch (error) { task = Promise.reject(error); }
    bindingDrains.add(task);
    void task.then(() => bindingDrains.delete(task), error => { bindingDrains.delete(task); bindingFailures.push(error); });
  };
  const runtime = await startWorker({ stateDirectory, loadIdentity: loadOrCreateWorkerIdentity, beforeUnlock: async () => {
    const results = await Promise.allSettled([execution?.close(), installed?.close(), installed?.rsyncWriters?.close()]);
    while (bindingDrains.size) await Promise.allSettled([...bindingDrains]);
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []).concat(bindingFailures);
    if (failures.length) throw new AggregateError(failures, 'Worker shutdown remains incomplete.');
    if (rsyncEntrypoint?.kind === 'configured') await rsyncEntrypoint.close();
  }, createConnection: async ({ bootId }) => {
    const pairing = await loadWorkerPairing(stateDirectory);
    const rootExtensions = await approvedRootExtensions(stateDirectory, pairing, bootId);
    if (!executionDomains) {
      if (!rsync) {
        try { rsyncEntrypoint = await loadWorkerRsyncEntrypoint({ path: join(stateDirectory, 'rsync-selection.json'), pairing,
          entryPoint: fileURLToPath(new URL('./rsync-writer.mjs', import.meta.url)),
          current: () => connection?.currentBinding(), ownership: () => installed?.rsyncOwnership,
          request: async (payload, signal) => {
            const captured = connection?.captureRequest('rsync-stage-v1');
            if (!captured) throw new WorkerError('rsync_authorization_unavailable');
            return captured.request(payload, { signal });
          } }); } catch (error) {
          process.stderr.write(`rsync unavailable: ${error.message}\n`);
          throw error;
        }
        if (rsyncEntrypoint.kind === 'unavailable') process.stderr.write(`rsync unavailable: ${rsyncEntrypoint.reason}\n`);
      }
      const configurationPath = join(stateDirectory, 'workflow-runtime.json');
      const selection = await lstat(configurationPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      const jobConfigurationPath = join(stateDirectory, 'job-runtime.json');
      const jobSelection = await lstat(jobConfigurationPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      installed = await createInstalledWorkerDomains({ stateDirectory, pairing, bootId,
        configuration: selection ? { path: configurationPath, ownerUid: process.getuid() } : null,
        jobConfiguration: jobSelection ? { path: jobConfigurationPath, ownerUid: process.getuid() } : null,
        approvedRoots: () => loadApprovedRoots(stateDirectory, pairing), connection: () => connection,
        ...(rsync ? { rsync } : rsyncEntrypoint?.kind === 'configured' ? { rsync: rsyncEntrypoint.providers } : {}),
        codexSuiteRevision: qualificationRevisionWithIdentity(codexQualificationSuite.revision) });
      if (installed.rsync) {
        for (const intent of installed.rsyncOwnership.inventory()) {
          if (Date.parse(intent.expiresAt) <= Date.now()) await installed.rsync.retireExpired(intent);
        }
      }
      if (!installed.rsyncAvailable && rsyncEntrypoint?.kind === 'configured') {
        process.stderr.write(`rsync unavailable: ${installed.rsyncMissing.join(', ')}\n`);
        throw new WorkerError('rsync_runtime_unavailable');
      }
    }
    connection = createWorkerConnection({ pairing, bootId, appVersion: manifest.version,
      onBindingLost: bindingLost,
      extensions: [...extensions, ...(execution?.extensions ?? []), ...(installed?.extensions ?? []), ...rootExtensions] });
    return connection;
  } });
  return runtime;
}
