import { mkdir, readFile } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadOrCreateWorkerIdentity, loadWorkerPairing } from '../../../packages/contracts/src/deviceIdentityNode.ts';
import { createWorkerConnection } from '../../../apps/api/src/modules/devices/workerConnection.ts';
import { doctorReport, executableAvailability, hostFacts, WorkerError, requirePrivateDirectory } from './diagnostics.mjs';
import { startWorker, readWorkerStatus } from './runtime.mjs';
import { validateManifest } from './installation.mjs';

const execute = promisify(execFile);
const args = process.argv.slice(2);
const command = args[0];
const stateDirectory = args.length === 3 && args[1] === '--state' && isAbsolute(args[2]) ? resolve(args[2]) : null;
let runtime;
async function main() {
  if (!stateDirectory || !['run', 'doctor'].includes(command)) throw new WorkerError('usage: graphql-worker run|doctor --state /absolute/private/directory');
  const facts = await hostFacts(process.env.HOME ?? '', [stateDirectory]);
  if (command === 'doctor') {
    let identity; const errors = [];
    try {
      await requirePrivateDirectory(stateDirectory);
      // Doctor is read-only, including when the worker has never initialized identity.
      await readFile(`${stateDirectory}/identity.json`);
      identity = await loadWorkerPairing(stateDirectory);
    } catch { errors.push('identity_invalid'); }
    let service = { active: false, userManagerAvailable: false };
    try {
      const { stdout } = await execute('/usr/bin/systemctl', ['--user', 'show', 'graphql-worker.service', '--property=ActiveState', '--property=LoadState'], { timeout: 2000, maxBuffer: 4096, env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS } });
      service = { active: stdout.includes('ActiveState=active\n'), userManagerAvailable: true };
    } catch { errors.push('systemd_user_manager_missing'); }
    const status = await readWorkerStatus(stateDirectory);
    service.active = service.active && status?.active === true;
    if (!status?.active) errors.push('service_not_running');
    const phase = status?.phase;
    const connection = { state: phase === 'ready' ? 'connected' : ['authenticating', 'negotiating', 'synchronizing'].includes(phase) ? 'connecting' : phase === 'disconnected' ? 'stopped' : phase };
    if (!facts.rootPersistent) errors.push('nonpersistent_root');
    if (!facts.homePersistent) errors.push('nonpersistent_home');
    console.log(JSON.stringify(doctorReport({ facts, identity, service, connection, executables: executableAvailability(process.env.PATH ?? ''), errors })));
    return;
  }
  if (!facts.rootPersistent || !facts.homePersistent || !facts.storagePersistent) throw new WorkerError('nonpersistent_storage');
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  validateManifest(manifest, facts, { protocolVersion: 1, identityFormat: 1 });
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  runtime = await startWorker({ stateDirectory, loadIdentity: loadOrCreateWorkerIdentity, createConnection: async ({ bootId }) => {
    const pairing = await loadWorkerPairing(stateDirectory);
    return createWorkerConnection({ pairing, bootId, appVersion: manifest.version });
  } });
  const stop = () => {
    runtime.stop().then(() => process.exit(0), () => { console.error('shutdown_timeout'); process.exit(1); });
  };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
main().catch((error) => { console.error(error instanceof WorkerError ? error.code : 'worker_start_failed'); process.exitCode = 1; });
