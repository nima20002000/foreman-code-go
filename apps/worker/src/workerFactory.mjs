import { mkdir, readFile } from 'node:fs/promises';
import { loadOrCreateWorkerIdentity, loadWorkerPairing } from '../../../packages/contracts/src/deviceIdentityNode.ts';
import { createWorkerConnection } from '../../../apps/api/src/modules/devices/workerConnection.ts';
import { hostFacts, requirePrivateDirectory, WorkerError } from './diagnostics.mjs';
import { validateManifest } from './installation.mjs';
import { startWorker } from './runtime.mjs';

export { createWorkerConnection };

export async function prepareWorkerState(stateDirectory) {
  const facts = await hostFacts(process.env.HOME ?? '', [stateDirectory]);
  if (!facts.rootPersistent || !facts.homePersistent || !facts.storagePersistent) throw new WorkerError('nonpersistent_storage');
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  validateManifest(manifest, facts, { protocolVersion: 1, identityFormat: 1 });
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await requirePrivateDirectory(stateDirectory);
  return manifest;
}

// Only supplied, actual domain registrations enter the authenticated transport.
// The package never manufactures dispatch handlers or another workflow authority.
export async function startConfiguredWorker({ stateDirectory, extensions = [] }) {
  const manifest = await prepareWorkerState(stateDirectory);
  return startWorker({ stateDirectory, loadIdentity: loadOrCreateWorkerIdentity, createConnection: async ({ bootId }) => {
    const pairing = await loadWorkerPairing(stateDirectory);
    return createWorkerConnection({ pairing, bootId, appVersion: manifest.version, extensions });
  } });
}
