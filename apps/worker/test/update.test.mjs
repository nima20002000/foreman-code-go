import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { WorkerUpdater, downloadWorkerArtifact } from '../src/update.mjs';
import { installVersion, readInstalledRelease, readRetainedRelease } from '../src/installation.mjs';
import { startWorker, acquireWorkerLock } from '../src/runtime.mjs';
import { WorkerError } from '../src/diagnostics.mjs';
import { readUpdateRecord, superviseWorkerUpdate, waitForWorkerReady, locateWorkerLaunch,
  launchUpdateSupervisor } from '../src/updateSupervisor.mjs';
import { recoverPendingWorkerUpdate, writeUpdateRecord, migrateWorkerService } from '../src/updateSupervisor.mjs';
import { renderUserService } from '../src/service.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const facts = { os: 'ubuntu', osRelease: '24.04', arch: 'x64', libc: 'glibc-2.39', node: 'v22.23.2',
  rootPersistent: true, homePersistent: true, storagePersistent: true };
const expected = { protocolVersion: 1, identityFormat: 1 };

async function artifact(base, version) {
  const directory = join(base, `artifact-${version}`);
  await mkdir(join(directory, 'src'), { recursive: true, mode: 0o700 });
  const bytes = Buffer.from(`console.log('${version}');\n`);
  await writeFile(join(directory, 'src/cli.mjs'), bytes, { mode: 0o600 });
  const { os, osRelease, arch, libc, node } = facts;
  const manifest = { format: 1, version, commit: 'a'.repeat(40), lockfileSha256: 'b'.repeat(64),
    packageManager: 'pnpm@11.27.0', protocolVersion: 1, identityFormat: 1,
    target: { os, osRelease, arch, libc, node },
    files: [{ path: 'src/cli.mjs', sha256: hash(bytes), size: bytes.length }] };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(directory, 'manifest.json'), manifestBytes, { mode: 0o600 });
  return { directory, release: { version, manifestSha256: hash(manifestBytes), manifest } };
}

async function fixture(t, targetVersion = '1.1.0') {
  const base = await mkdtemp(join(tmpdir(), 'worker-update-'));
  const root = join(base, 'app');
  const stateDirectory = join(base, 'state');
  await mkdir(stateDirectory, { mode: 0o700 });
  const previous = await artifact(base, '1.0.0');
  const incoming = await artifact(base, targetVersion);
  await installVersion({ root, stateDirectory, facts, expected, artifact: previous.directory,
    approvedManifestSha256: previous.release.manifestSha256 });
  const workerInstallationId = randomUUID();
  let runtime;
  let assertStateOwnership;
  let beforeUnlock;
  const connections = [];
  const boot = async (version, phase = 'ready') => {
    runtime = await startWorker({ stateDirectory, appVersion: version,
      beforeUnlock: () => beforeUnlock?.(),
      loadIdentity: async () => ({ workerInstallationId }),
      readBootId: async () => '11111111-1111-4111-8111-111111111111',
      createConnection: async input => {
        assertStateOwnership = input.assertStateOwnership;
        connections.push(version);
        return { start: async () => {}, stop: async () => {}, status: () => ({ phase }) };
      } });
  };
  await boot('1.0.0');
  t.after(async () => {
    await runtime?.stop();
    await rm(base, { recursive: true, force: true });
  });
  const requests = [];
  const request = async payload => {
    requests.push(payload);
    if (payload.operation === 'release') return { payload: { operation: 'release', release: incoming.release } };
    assert.equal(payload.manifestSha256, incoming.release.manifestSha256);
    const bytes = (await readFile(join(incoming.directory, payload.path))).subarray(payload.offset,
      payload.offset + 262_144);
    return { payload: { ...payload, byteSize: bytes.length }, bytes };
  };
  const launch = { root, stateDirectory, service: 'graphql-worker.service',
    pointer: { kind: 'symlink', path: join(root, 'current') },
    previousDirectory: (await readInstalledRelease({ root, facts, expected })).directory,
    unitPath: join(base, '.config/systemd/user/graphql-worker.service') };
  await mkdir(join(launch.unitPath, '..'), { recursive: true, mode: 0o700 });
  const template = await readFile(new URL('../artifacts/graphql-worker.service.in', import.meta.url), 'utf8');
  await writeFile(launch.unitPath, renderUserService(template, { node: process.execPath, app: root,
    state: stateDirectory, home: base, path: '/usr/bin:/bin',
    entrypoint: join(launch.previousDirectory, 'src/cli.mjs') }), { mode: 0o600 });
  const prepareService = plan => migrateWorkerService(plan, { run: async (_binary, args) => ({
    stdout: args.includes('--property=FragmentPath') ? `${launch.unitPath}\n` : '',
  }) });
  const options = { stateDirectory, version: '1.0.0', manifestSha256: previous.release.manifestSha256,
    releaseDirectory: launch.previousDirectory, workerInstallationId, facts,
    assertStateOwnership: () => assertStateOwnership(), connection: () => ({ captureRequest: () => ({ request }) }),
    drain: async () => {}, resume: () => {}, locateLaunch: async () => launch,
    launchSupervisor: async () => {} };
  return { base, root, stateDirectory, previous, incoming, requests, options, connections, prepareService,
    setBeforeUnlock: callback => { beforeUnlock = callback; }, stopRuntime: () => runtime.stop(),
    restart: async phase => {
      await runtime.stop();
      const unit = await readFile(launch.unitPath, 'utf8');
      const [, node, entrypoint] = unit.match(/^ExecStart=(\S+) (\S+)/m);
      const child = spawnSync(node, [entrypoint, 'run', '--state', stateDirectory], { encoding: 'utf8', timeout: 2000 });
      assert.equal(child.status, 0, child.stderr);
      await boot(child.stdout.trim(), phase);
    } };
}

async function until(predicate) {
  for (let count = 0; count < 200; count++) {
    if (await predicate()) return;
    await wait(5);
  }
  throw new Error('Worker update did not reach the expected state.');
}

test('downloads a release from its GitHub release asset and still verifies every byte against the manifest', async t => {
  const base = await mkdtemp(join(tmpdir(), 'worker-github-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const built = await artifact(base, '1.2.0');
  const archive = join(base, 'asset.tar.gz');
  spawnSync('tar', ['-czf', archive, '-C', built.directory, '.']);
  const github = { repository: 'octo/site', tag: `worker-${'c'.repeat(40)}` };
  const requested = [];
  const fetchAsset = async input => {
    requested.push({ github: input.github, asset: input.asset });
    await writeFile(input.destination, await readFile(archive));
  };
  const request = async () => { throw new Error('No chunk may come through Main.'); };
  const release = { ...built.release, github };
  const installed = join(base, 'installed');
  const manifest = await downloadWorkerArtifact({ release, request, directory: installed, facts, fetchAsset });
  assert.deepEqual(requested, [{ github, asset: `${built.release.manifestSha256}.tar.gz` }]);
  assert.equal(manifest.version, '1.2.0');
  assert.equal(await readFile(join(installed, 'src/cli.mjs'), 'utf8'), "console.log('1.2.0');\n");

  await writeFile(join(built.directory, 'src/cli.mjs'), "console.log('tampered');\n");
  spawnSync('tar', ['-czf', archive, '-C', built.directory, '.']);
  await assert.rejects(downloadWorkerArtifact({ release, request, directory: join(base, 'tampered'), facts, fetchAsset }),
    { code: 'artifact_checksum_mismatch' });
});

test('authenticated-ready check detects Main version mismatch, installs and reconnects at the matching version', async t => {
  const f = await fixture(t);
  let supervised;
  const updater = await new WorkerUpdater({ ...f.options, launchSupervisor: async () => {
    supervised = superviseWorkerUpdate(await readUpdateRecord(f.stateDirectory), {
      restart: () => f.restart('ready'), prepareService: f.prepareService,
    });
    await supervised;
  } }).initialize();
  t.after(() => updater.close());
  updater.ready();
  await until(async () => (await readUpdateRecord(f.stateDirectory)).status.state === 'current'
    && f.connections.length === 2);
  await supervised;
  assert.deepEqual(f.connections, ['1.0.0', '1.1.0']);
  assert.equal((await readInstalledRelease({ root: f.root, facts, expected })).manifest.version, '1.1.0');
  assert.equal((await readRetainedRelease(f.root)).manifest.version, '1.0.0');
  const restarted = await new WorkerUpdater({ ...f.options, version: '1.1.0',
    manifestSha256: f.incoming.release.manifestSha256 }).initialize();
  assert.deepEqual(await restarted.status(), { currentVersion: '1.1.0', targetVersion: '1.1.0',
    state: 'current', lastError: null });
  restarted.close();
});

test('concurrent status polling preserves saved update transitions and metadata', async t => {
  const f = await fixture(t);
  const updater = await new WorkerUpdater(f.options).initialize();
  t.after(() => updater.close());
  const manifestSha256 = f.incoming.release.manifestSha256;
  const pending = updater.save({ targetVersion: '1.1.0', state: 'pending' }, { manifestSha256 });
  const pendingStatus = updater.status();
  const draining = updater.save({ state: 'draining' });
  const drainingStatus = updater.status();
  await Promise.all([pending, draining]);
  assert.deepEqual(await pendingStatus, { currentVersion: '1.0.0', targetVersion: '1.1.0',
    state: 'pending', lastError: null });
  const status = await drainingStatus;
  assert.deepEqual(status, { currentVersion: '1.0.0', targetVersion: '1.1.0',
    state: 'draining', lastError: null });
  const retained = await readUpdateRecord(f.stateDirectory);
  assert.deepEqual(retained.status, status);
  assert.equal(retained.manifestSha256, manifestSha256);
});

test('busy work drains naturally before any artifact download or restart', async t => {
  const f = await fixture(t);
  let finishWork;
  let resumed = 0;
  const work = new Promise(resolve => { finishWork = resolve; });
  const updater = await new WorkerUpdater({ ...f.options, drain: () => work,
    resume: () => { resumed++; } }).initialize();
  t.after(() => {
    finishWork();
    return updater.close();
  });
  const update = updater.start();
  await until(async () => (await updater.status()).state === 'draining');
  assert.equal(f.requests.filter(request => request.operation === 'chunk').length, 0);
  assert.equal(resumed, 0);
  assert.equal((await readInstalledRelease({ root: f.root, facts, expected })).manifest.version, '1.0.0');
  finishWork();
  await update;
  assert.equal((await updater.status()).state, 'restarting');
  assert.equal(resumed, 0);
});

for (const path of ['manifest.json', 'src/cli.mjs']) {
  test(`rejects changed ${path} bytes and resumes the running release`, async t => {
    const f = await fixture(t);
    await writeFile(join(f.incoming.directory, path), 'corrupt bytes');
    const current = await readlink(join(f.root, 'current'));
    let resumed = 0;
    let launched = false;
    const updater = await new WorkerUpdater({ ...f.options, resume: () => { resumed++; },
      launchSupervisor: async () => { launched = true; } }).initialize();
    t.after(() => updater.close());
    await assert.rejects(updater.start(), error => error.code === (path === 'manifest.json'
      ? 'manifest_checksum_mismatch' : 'artifact_checksum_mismatch'));
    assert.equal(await readlink(join(f.root, 'current')), current);
    assert.equal((await updater.status()).state, 'failed');
    assert.equal(resumed, 1);
    assert.equal(launched, false);
  });
}

test('failed new startup restores the previous pointer and persists rollback across Worker restart', async t => {
  const f = await fixture(t);
  let restarts = 0;
  const updater = await new WorkerUpdater({ ...f.options, launchSupervisor: async () => {
    await superviseWorkerUpdate(await readUpdateRecord(f.stateDirectory), {
      prepareService: f.prepareService,
      restart: async () => { await f.restart(++restarts === 1 ? 'authenticating' : 'ready'); },
      ready: options => waitForWorkerReady({ ...options, timeoutMs: 15, pollMs: 1 }),
    });
  } }).initialize();
  t.after(() => updater.close());
  await updater.start();
  assert.deepEqual(f.connections, ['1.0.0', '1.1.0', '1.0.0']);
  assert.equal((await readInstalledRelease({ root: f.root, facts, expected })).manifest.version, '1.0.0');
  const restarted = await new WorkerUpdater(f.options).initialize();
  assert.deepEqual(await restarted.status(), { currentVersion: '1.0.0', targetVersion: '1.1.0',
    state: 'rolled-back', lastError: 'worker_update_startup_timeout' });
  await restarted.start();
  assert.equal(restarts, 2);
  restarted.close();
});

test('authenticated Main rollback can install its matching older version without changing manual install policy', async t => {
  const f = await fixture(t, '0.9.0');
  const updater = await new WorkerUpdater({ ...f.options, launchSupervisor: async () => {
    await superviseWorkerUpdate(await readUpdateRecord(f.stateDirectory), {
      restart: () => f.restart('ready'), prepareService: f.prepareService });
  } }).initialize();
  t.after(() => updater.close());
  await updater.start();
  assert.equal((await readInstalledRelease({ root: f.root, facts, expected })).manifest.version, '0.9.0');
});

test('supervisor launch failure keeps the old pointer and resumes admissions with persisted failure', async t => {
  const f = await fixture(t);
  let resumed = 0;
  const updater = await new WorkerUpdater({ ...f.options, resume: () => { resumed++; },
    launchSupervisor: async () => { throw new WorkerError('worker_update_supervisor_unavailable'); } }).initialize();
  t.after(() => updater.close());
  await assert.rejects(updater.start(), { code: 'worker_update_supervisor_unavailable' });
  assert.equal((await readInstalledRelease({ root: f.root, facts, expected })).manifest.version, '1.0.0');
  assert.equal(resumed, 1);
  assert.equal((await updater.status()).lastError, 'worker_update_supervisor_unavailable');
});

test('the next Worker retries an update cut short by a Worker stop, but not an update that failed', async t => {
  const f = await fixture(t);
  let stageEntered = false;
  const stopped = await new WorkerUpdater({ ...f.options,
    stage: async () => { stageEntered = true; await wait(50); return { directory: f.incoming.directory }; },
  }).initialize();
  const update = stopped.start();
  await until(() => stageEntered);
  await stopped.close();
  await assert.rejects(update, { code: 'worker_updater_stopped' });
  assert.equal((await readUpdateRecord(f.stateDirectory)).status.state, 'failed');
  let launched = 0;
  const next = await new WorkerUpdater({ ...f.options, launchSupervisor: async () => { launched++; } }).initialize();
  t.after(() => next.close());
  assert.equal(await next.start(), 'Worker 1.1.0 restart is scheduled.');
  assert.equal(launched, 1);
  assert.equal((await next.status()).state, 'restarting');

  const g = await fixture(t);
  const failed = await new WorkerUpdater({ ...g.options,
    launchSupervisor: async () => { throw new WorkerError('worker_update_supervisor_unavailable'); } }).initialize();
  await assert.rejects(failed.start(), { code: 'worker_update_supervisor_unavailable' });
  await failed.close();
  const later = await new WorkerUpdater({ ...g.options, launchSupervisor: async () => { launched++; } }).initialize();
  t.after(() => later.close());
  assert.equal(await later.start(), 'Worker update needs a retry.');
  assert.equal(launched, 1);
});

test('manual retry clears an earlier failure when Main now serves the already running release', async t => {
  const f = await fixture(t);
  const updater = await new WorkerUpdater({ ...f.options,
    launchSupervisor: async () => { throw new WorkerError('worker_update_supervisor_unavailable'); } }).initialize();
  t.after(() => updater.close());
  await assert.rejects(updater.start(), { code: 'worker_update_supervisor_unavailable' });
  f.incoming.release = f.previous.release;
  assert.equal(await updater.start({ retry: true }), 'Worker 1.0.0 is current.');
  assert.deepEqual(await updater.status(), { currentVersion: '1.0.0', targetVersion: '1.0.0',
    state: 'current', lastError: null });
});

test('ready health requires both authenticated connection readiness and the original installation identity', async t => {
  const f = await fixture(t);
  await assert.rejects(waitForWorkerReady({ stateDirectory: f.stateDirectory, version: '1.0.0',
    workerInstallationId: randomUUID(), timeoutMs: 10, pollMs: 1 }), { code: 'worker_update_startup_timeout' });
  await waitForWorkerReady({ stateDirectory: f.stateDirectory, version: '1.0.0',
    workerInstallationId: f.options.workerInstallationId });
});

test('existing CI service launch is accepted only when its pointer names the running release', async t => {
  const f = await fixture(t);
  const directory = join(f.base, '.local/share/foreman-code/ci-verification');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'worker-release-path');
  await writeFile(path, `${f.options.releaseDirectory}\n`, { mode: 0o600 });
  const options = { ...f.options, home: f.base, pid: 123, run: async (_binary, args) => ({
    stdout: args.includes('foreman-ci-worker.service') ? '123\n' : '0\n',
  }) };
  const launch = await locateWorkerLaunch(options);
  assert.deepEqual(launch.pointer, { kind: 'file', path });
  await writeFile(path, `${f.incoming.directory}\n`, { mode: 0o600 });
  await assert.rejects(locateWorkerLaunch(options), { code: 'worker_release_pointer_mismatch' });
});

test('external supervisor launch rejects before restart when systemd refuses its transient service', async t => {
  const f = await fixture(t);
  const updater = await new WorkerUpdater({ ...f.options, launchSupervisor: async stateDirectory => {
    await launchUpdateSupervisor(stateDirectory, {
      run: async () => { throw new WorkerError('worker_update_supervisor_unavailable'); },
    });
  } }).initialize();
  t.after(() => updater.close());
  await assert.rejects(updater.start(), { code: 'worker_update_supervisor_unavailable' });
  assert.equal((await readInstalledRelease({ root: f.root, facts, expected })).manifest.version, '1.0.0');
});

test('startup recovers an unfinished restart after its supervisor service disappeared', async t => {
  const f = await fixture(t);
  const updater = await new WorkerUpdater(f.options).initialize();
  t.after(() => updater.close());
  await updater.start();
  const record = await readUpdateRecord(f.stateDirectory);
  record.restart.unit = `foreman-worker-update-${randomUUID()}`;
  await writeUpdateRecord(f.stateDirectory, record);
  let launches = 0;
  const launch = async stateDirectory => {
    launches++;
    await superviseWorkerUpdate(await readUpdateRecord(stateDirectory), {
      restart: () => f.restart('ready'), prepareService: f.prepareService });
  };
  await recoverPendingWorkerUpdate(f.stateDirectory, { run: async () => ({ stdout: 'active\n' }), launch });
  assert.equal(launches, 0);
  await recoverPendingWorkerUpdate(f.stateDirectory, { run: async () => ({ stdout: 'inactive\n' }), launch });
  assert.equal(launches, 1);
  assert.equal((await readUpdateRecord(f.stateDirectory)).status.state, 'current');
  assert.equal((await readInstalledRelease({ root: f.root, facts, expected })).manifest.version, '1.1.0');
});

test('shutdown waits for an active staging operation and prevents a restart after ownership can change', async t => {
  const f = await fixture(t);
  let finishStage;
  let stageEntered = false;
  let launched = false;
  const gate = new Promise(resolve => { finishStage = resolve; });
  const updater = await new WorkerUpdater({ ...f.options,
    stage: async () => { stageEntered = true; await gate; return { directory: f.incoming.directory }; },
    launchSupervisor: async () => { launched = true; } }).initialize();
  const update = updater.start();
  await until(() => stageEntered);
  f.setBeforeUnlock(() => updater.close());
  let stopped = false;
  const closing = f.stopRuntime().then(() => { stopped = true; });
  await wait(10);
  assert.equal(stopped, false);
  await assert.rejects(acquireWorkerLock(f.stateDirectory), { code: 'worker_already_running' });
  finishStage();
  await assert.rejects(update, { code: 'worker_updater_stopped' });
  await closing;
  assert.equal(stopped, true);
  assert.equal(launched, false);
  assert.equal((await readUpdateRecord(f.stateDirectory)).status.state, 'failed');
  assert.equal((await readInstalledRelease({ root: f.root, facts, expected })).manifest.version, '1.0.0');
  const releaseOwnership = await acquireWorkerLock(f.stateDirectory);
  await releaseOwnership();
});

test('consecutive releases retain the first terminal maintenance outcome without an intermediate poll', async t => {
  const f = await fixture(t);
  const startedAt = new Date().toISOString();
  const launchSupervisor = async () => {
    await superviseWorkerUpdate(await readUpdateRecord(f.stateDirectory), {
      restart: () => f.restart('ready'), prepareService: f.prepareService });
  };
  const first = await new WorkerUpdater({ ...f.options, launchSupervisor }).initialize();
  await first.start();
  await first.close();
  const release = await readInstalledRelease({ root: f.root, facts, expected });
  const next = await artifact(f.base, '1.2.0');
  f.incoming.directory = next.directory;
  f.incoming.release = next.release;
  const second = await new WorkerUpdater({ ...f.options, version: '1.1.0', manifestSha256: release.manifestSha256,
    locateLaunch: async () => ({ ...await f.options.locateLaunch(), previousDirectory: release.directory }),
    launchSupervisor }).initialize();
  await second.start();
  assert.equal((await readUpdateRecord(f.stateDirectory)).status.currentVersion, '1.2.0');
  assert.deepEqual(await second.maintenanceOutcome({ workerTargetVersion: '1.1.0', startedAt }), {
    currentVersion: '1.1.0', targetVersion: '1.1.0', state: 'current', lastError: null,
  });
  await second.close();
});

test('a later successful retry of the same target preserves the earlier task rollback outcome', async t => {
  const f = await fixture(t);
  let restarts = 0;
  const firstStartedAt = new Date().toISOString();
  const updater = await new WorkerUpdater({ ...f.options, launchSupervisor: async () => {
    await superviseWorkerUpdate(await readUpdateRecord(f.stateDirectory), {
      prepareService: f.prepareService, restart: () => f.restart(++restarts === 1 ? 'authenticating' : 'ready'),
      ready: options => waitForWorkerReady({ ...options, timeoutMs: 15, pollMs: 1 }),
    });
  } }).initialize();
  t.after(() => updater.close());
  await updater.start();
  await wait(2);
  const retryStartedAt = new Date().toISOString();
  await updater.start({ retry: true });
  assert.equal((await updater.maintenanceOutcome({ workerTargetVersion: '1.1.0', startedAt: firstStartedAt })).state,
    'rolled-back');
  assert.equal((await updater.maintenanceOutcome({ workerTargetVersion: '1.1.0', startedAt: retryStartedAt })).state,
    'current');
});
