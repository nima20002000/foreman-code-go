import { RemoteOperationJournal } from '../../../apps/api/src/modules/runs/remote/operationJournal.ts';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInstalledWorkerDomains } from '../../../apps/api/src/modules/devices/installedWorkerDomains.ts';
import { codexQualificationSuite } from '../../../apps/api/src/modules/harnesses/qualification/suites/codex.ts';
import { loadApprovedRoots } from './approvedRoots.mjs';
import { createWorkerExecutionDomains } from '../../../apps/api/src/modules/runs/remote/workerComposition.ts';
import { mkdir, readFile } from 'node:fs/promises';
import { loadOrCreateWorkerIdentity, loadWorkerPairing } from '../../../packages/contracts/src/deviceIdentityNode.ts';
import { createWorkerConnection } from '../../../apps/api/src/modules/devices/workerConnection.ts';
import { hostFacts, requirePrivateDirectory, WorkerError } from './diagnostics.mjs';
import { validateManifest } from './installation.mjs';
import { startWorker, acquireWorkerLock } from './runtime.mjs';
import { approvedRootExtensions } from './rootExtension.mjs';

export { createWorkerConnection };
export { approvedRootExtensions, createWorkerExecutionDomains };
// Read-only qualification helper for the explicit human installation gate only.
// Startup consumes and verifies the approved facts; it never calls this helper.
export { qualifyApprovedRootAllowlist } from '../../../apps/api/src/modules/sources/rootAttestation.ts';

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
    const path = join(stateDirectory, 'workflow-operations.json');
    const existing = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (existing) throw new WorkerError('native_runtime_already_initialized');
    const originalRegistry = await lstat(join(stateDirectory, 'workflow-native-processes')).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (originalRegistry) throw new WorkerError('native_runtime_recovery_required');
    const journal = await RemoteOperationJournal.open(path, { initializeNewInstallation: true });
    await journal.close();
  } finally { await unlock(); }
}

// Only supplied, actual domain registrations enter the authenticated transport.
// The package never manufactures dispatch handlers or another workflow authority.
export async function startConfiguredWorker({ stateDirectory, extensions = [], executionDomains }) {
  const manifest = await prepareWorkerState(stateDirectory);
  const execution = executionDomains ? createWorkerExecutionDomains(executionDomains) : undefined;
  let installed, connection;
  const runtime = await startWorker({ stateDirectory, loadIdentity: loadOrCreateWorkerIdentity, createConnection: async ({ bootId }) => {
    const pairing = await loadWorkerPairing(stateDirectory);
    const rootExtensions = await approvedRootExtensions(stateDirectory, pairing, bootId);
    if (!executionDomains) {
      const configurationPath = join(stateDirectory, 'workflow-runtime.json');
      const selection = await lstat(configurationPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      const jobConfigurationPath = join(stateDirectory, 'job-runtime.json');
      const jobSelection = await lstat(jobConfigurationPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      installed = await createInstalledWorkerDomains({ stateDirectory, pairing, bootId,
        configuration: selection ? { path: configurationPath, ownerUid: process.getuid() } : null,
        jobConfiguration: jobSelection ? { path: jobConfigurationPath, ownerUid: process.getuid() } : null,
        approvedRoots: () => loadApprovedRoots(stateDirectory, pairing), connection: () => connection,
        codexSuiteRevision: codexQualificationSuite.revision });
    }
    connection = createWorkerConnection({ pairing, bootId, appVersion: manifest.version,
      extensions: [...extensions, ...(execution?.extensions ?? []), ...(installed?.extensions ?? []), ...rootExtensions] });
    return connection;
  } });
  let stopping;
  return { ...runtime, stop() { return stopping ??= (async () => {
    const results = await Promise.allSettled([execution?.close(), installed?.close()]);
    const transport = await Promise.allSettled([runtime.stop()]);
    const failures = [...results, ...transport].flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, 'Worker shutdown remains incomplete.');
  })(); } };
}
