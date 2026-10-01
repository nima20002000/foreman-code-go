import { readFile } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { doctorReport, executableAvailability, hostFacts, WorkerError, requirePrivateDirectory } from './diagnostics.mjs';
import { readWorkerStatus } from './runtime.mjs';

const execute = promisify(execFile);
const args = process.argv.slice(2);
const command = args[0];
const stateDirectory = [3, 4, 5].includes(args.length) && args[1] === '--state' && isAbsolute(args[2]) ? resolve(args[2]) : null;
let runtime;
let pairingErrorMessage;
const help = `Usage:
  graphql-worker run|doctor|identity-request|initialize-native-runtime --state /absolute/private/state
  graphql-worker pair --state /absolute/private/state --enrollment-stdin
  graphql-worker pair --state /absolute/private/state --enrollment-file /absolute/private/enrollment.json

Install: node /approved/artifact/src/install-cli.mjs install --root /private/app --state /private/state --artifact /approved/artifact --manifest-sha256 APPROVED_SHA256
Update: use the same install command with the new approved artifact and hash, adding --approve-stopped-update yes.
Rollback: node /approved/artifact/src/install-cli.mjs rollback --root /private/app --state /private/state --approve-stopped-update yes
Before update or rollback, complete the approved drain/stop policy and stop the worker service. An active worker blocks replacement.
Initialize-native-runtime is an explicit new-installation action. A lost established journal requires original-owner recovery.
Keep app and state in separate private persistent directories. Pairing retries reuse the original enrollment file, requestId and state identity.
`;
async function main() {
  if (!args.length || args.includes('--help') || args.includes('-h')) { process.stdout.write(help); return; }
  if (!stateDirectory || !['run', 'doctor', 'identity', 'identity-request', 'pair', 'initialize-native-runtime'].includes(command) || (command !== 'pair' && args.length !== 3) || (command === 'pair' && !((args.length===4&&args[3]==='--enrollment-stdin')||(args.length===5&&args[3]==='--enrollment-file'&&isAbsolute(args[4]))))) throw new WorkerError('usage: graphql-worker run|doctor|identity|pair --state /absolute/private/directory [--enrollment-file /private/file]');
  const { loadOrCreateWorkerIdentity, loadWorkerPairing } = await import('../../../packages/contracts/src/deviceIdentityNode.ts');
  const { prepareWorkerState, startConfiguredWorker, initializeInstalledNativeRuntime } = await import('./workerFactory.mjs');
  const enrollment = command === 'pair' ? await import('./enrollment.mjs') : null;
  pairingErrorMessage = enrollment?.pairingErrorMessage;
  const facts = await hostFacts(process.env.HOME ?? '', [stateDirectory]);
  if (command === 'doctor') {
    let identity; const errors = [];
    try {
      const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
      Object.assign(facts, { appVersion: manifest.version, protocolVersion: manifest.protocolVersion, identityFormat: manifest.identityFormat, commit: manifest.commit, lockfileSha256: manifest.lockfileSha256 });
    } catch { /* An absent artifact manifest is represented by null version fields. */ }
    try {
      await requirePrivateDirectory(stateDirectory);
      // Doctor is read-only, including when the worker has never initialized identity.
      await readFile(`${stateDirectory}/identity.json`);
      identity = await loadOrCreateWorkerIdentity(stateDirectory);
      try { identity = { ...identity, ...await loadWorkerPairing(stateDirectory) }; }
      catch (error) { if (error.code !== 'ENOENT') errors.push('identity_invalid'); }
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
    const connection = { state: phase === 'ready' ? 'connected' : ['authenticating', 'negotiating', 'synchronizing'].includes(phase) ? 'connecting' : phase === 'disconnected' ? 'stopped' : phase, failure: status?.failure };
    if (!facts.rootPersistent) errors.push('nonpersistent_root');
    if (!facts.homePersistent) errors.push('nonpersistent_home');
    console.log(JSON.stringify(doctorReport({ facts, identity, service, connection, executables: executableAvailability(process.env.PATH ?? ''), errors })));
    return;
  }
  if (command === 'initialize-native-runtime') { await initializeInstalledNativeRuntime(stateDirectory); console.log(JSON.stringify({ nativeRuntime: 'initialized', executionAuthorized: false })); return; }
  const manifest = command === 'run' ? null : await prepareWorkerState(stateDirectory);
  if (command === 'pair') {
    await requirePrivateDirectory(stateDirectory);
    // One selected main: never call enrollment to overwrite an existing pairing.
    try { await readFile(`${stateDirectory}/pairing.json`); throw new WorkerError('already_paired'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const identity = await loadOrCreateWorkerIdentity(stateDirectory);
    const result=args[3]==='--enrollment-stdin'?await enrollment.enrollWorkerCode({stateDirectory,identity,enrollmentCode:await import('./setupInput.mjs').then(module=>module.readPrivateEnrollmentCode()),appVersion:manifest.version}):await enrollment.enrollWorker({stateDirectory,identity,enrollmentFile:args[4],appVersion:manifest.version});
    console.log(JSON.stringify(result));
    return;
  }
  if(command==='identity-request'){await requirePrivateDirectory(stateDirectory);const identity=await loadOrCreateWorkerIdentity(stateDirectory);const {workerIdentityRequestCode}=await import('../../../packages/contracts/src/deviceSetupNode.ts');process.stdout.write(workerIdentityRequestCode(identity)+'\n');return;}
  if (command === 'identity') {
    await requirePrivateDirectory(stateDirectory);
    const identity = await loadOrCreateWorkerIdentity(stateDirectory);
    console.log(JSON.stringify({ formatVersion: identity.formatVersion, workerInstallationId: identity.workerInstallationId, keyRevision: identity.keyRevision, publicKey: identity.publicKey, publicKeyFingerprint: identity.publicKeyFingerprint }));
    return;
  }
  runtime = await startConfiguredWorker({ stateDirectory });
  const stop = () => {
    runtime.stop().then(() => process.exit(0), () => { console.error('shutdown_timeout'); process.exit(1); });
  };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
main().catch((error) => { console.error(command === 'pair' && pairingErrorMessage ? pairingErrorMessage(error) : error instanceof WorkerError ? error.code : 'worker_start_failed'); process.exitCode = 1; });
