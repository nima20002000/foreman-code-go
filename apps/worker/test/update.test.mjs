import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { persistentFixtureRoot } from './fixtureStorage.mjs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { WorkerUpdater, downloadWorkerArtifact, fetchGitHubAsset } from '../src/update.mjs';
import { installVersion, readInstalledRelease, readRetainedRelease } from '../src/installation.mjs';
import { startWorker, acquireWorkerLock } from '../src/runtime.mjs';
import { WorkerError } from '../src/diagnostics.mjs';
import { readUpdateRecord, superviseWorkerUpdate, waitForWorkerReady, locateWorkerLaunch,
  launchUpdateSupervisor } from '../src/updateSupervisor.mjs';
import { recoverPendingWorkerUpdate, writeUpdateRecord, migrateWorkerService } from '../src/updateSupervisor.mjs';
import { renderUserService } from '../src/service.mjs';
import { DeviceConnectionError } from '../../../apps/api/src/modules/devices/deviceWire.ts';
import { DeviceApplicationError } from '../../../apps/api/src/modules/devices/deviceApplicationError.ts';
import { COMPUTER_MAINTENANCE_NAMESPACE } from '@foreman-code/contracts/computer-maintenance';
let bundleDirectory;
let createWorkerRuntimeDrain;
before(async () => {
  bundleDirectory = await mkdtemp(join(persistentFixtureRoot, 'worker-update-module-'));
  const output = join(bundleDirectory, 'drain.mjs');
  const domains = new URL('../../../apps/api/src/modules/devices/installedWorkerDomains.ts', import.meta.url);
  await build({ stdin: {
    contents: `export { createWorkerRuntimeDrain } from ${JSON.stringify(fileURLToPath(domains))};`,
    resolveDir: fileURLToPath(new URL('../../../', import.meta.url)),
  }, outfile: output, bundle: true, platform: 'node', format: 'esm', target: 'node22', external: ['sharp'],
  banner: { js: "import { createRequire as testCreateRequire } from 'node:module'; const require = testCreateRequire(import.meta.url);" } });
  ({ createWorkerRuntimeDrain } = await import(pathToFileURL(output).href));
});
after(async () => {
  if (bundleDirectory) await rm(bundleDirectory, { recursive: true, force: true });
});

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
  const base = await mkdtemp(join(persistentFixtureRoot, 'worker-update-'));
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
    if (payload.operation === 'ci-smoke') return { payload: { operation: 'ci-smoke', ciSmoke: null } };
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

test('Worker status advertises the running manifest even after a failed target update', async t => {
  const f = await fixture(t);
  const updater = await new WorkerUpdater(f.options).initialize();
  t.after(() => updater.close());
  await updater.save({ state: 'rolled-back', lastError: 'worker_update_startup_timeout' },
    { manifestSha256: f.incoming.release.manifestSha256 });
  assert.equal((await updater.status()).manifestSha256, f.previous.release.manifestSha256);
});

test('update supervision allows bounded capacity drain and smoke before rolling back', async t => {
  const f = await fixture(t);
  const updater = await new WorkerUpdater({ ...f.options, launchSupervisor: async () => {
    await superviseWorkerUpdate(await readUpdateRecord(f.stateDirectory), {
      prepareService: f.prepareService, restart: () => f.restart('ready'),
      ready: async options => {
        assert.ok(options.timeoutMs >= 30 * 60_000 + 160_000,
          'Startup supervision must include the capacity wait and smoke execution budgets.');
        await waitForWorkerReady({ ...options, timeoutMs: 1000, pollMs: 1 });
      },
    });
  } }).initialize();
  t.after(() => updater.close());
  await updater.start();
  assert.equal((await readUpdateRecord(f.stateDirectory)).status.state, 'current');
});

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
  assert.equal(spawnSync(process.execPath, [join(installed, 'src/cli.mjs')], { encoding: 'utf8' }).stdout, '1.2.0\n');

  await writeFile(join(built.directory, 'src/cli.mjs'), "console.log('2.1.0');\n");
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
    manifestSha256: f.incoming.release.manifestSha256,
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
    manifestSha256: f.previous.release.manifestSha256,
    state: 'pending', lastError: null });
  const status = await drainingStatus;
  assert.deepEqual(status, { currentVersion: '1.0.0', targetVersion: '1.1.0',
    manifestSha256: f.previous.release.manifestSha256,
    state: 'draining', lastError: null });
  const retained = await readUpdateRecord(f.stateDirectory);
  assert.deepEqual(retained.status, status);
  assert.equal(retained.manifestSha256, manifestSha256);
});

test('busy work drains naturally after the verified download and before installation or restart', async t => {
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
  assert.ok(f.requests.some(request => request.operation === 'chunk'));
  assert.equal(resumed, 0);
  assert.equal((await readInstalledRelease({ root: f.root, facts, expected })).manifest.version, '1.0.0');
  finishWork();
  await update;
  assert.equal((await updater.status()).state, 'restarting');
  assert.equal(resumed, 0);
});

test('an idle Worker keeps admitting work while its update downloads slowly through Main', async t => {
  const f = await fixture(t);
  const drain = createWorkerRuntimeDrain({ signal: new AbortController().signal,
    active: () => [], drainJobs: async () => {}, drainQualifications: async () => {},
    drainMaintenance: async () => {}, quiescent: async () => true });
  // Before Main publishes the GitHub release asset, every artifact chunk crosses the device channel.
  let finishDownload;
  const downloaded = new Promise(resolve => { finishDownload = resolve; });
  let chunkWaiting = false;
  const original = f.options.connection().captureRequest().request;
  const updater = await new WorkerUpdater({ ...f.options, drain: () => drain.run(), resume: () => drain.resume(),
    connection: () => ({ captureRequest: () => ({ request: async payload => {
      if (payload.operation === 'chunk') {
        chunkWaiting = true;
        await downloaded;
      }
      return original(payload);
    } }) }) }).initialize();
  t.after(() => {
    finishDownload();
    return updater.close();
  });
  const update = updater.start();
  await until(() => chunkWaiting);
  assert.equal((await updater.status()).state, 'downloading');
  assert.doesNotThrow(() => drain.assertAdmission('harness-discovery-v1', {}));
  assert.doesNotThrow(() => drain.assertAdmission('execution-v1', { method: 'prepare' }));
  finishDownload();
  assert.equal(await update, 'Worker 1.1.0 restart is scheduled.');
  assert.throws(() => drain.assertAdmission('harness-discovery-v1', {}), { code: 'WORKER_RUNTIME_DRAINING' });
});

for (const path of ['manifest.json', 'src/cli.mjs']) {
  test(`rejects changed ${path} bytes and keeps the running release admitting work`, async t => {
    const f = await fixture(t);
    await writeFile(join(f.incoming.directory, path), 'corrupt bytes');
    const current = await readlink(join(f.root, 'current'));
    let drained = 0;
    let resumed = 0;
    let launched = false;
    const updater = await new WorkerUpdater({ ...f.options, drain: async () => { drained++; },
      resume: () => { resumed++; }, launchSupervisor: async () => { launched = true; } }).initialize();
    t.after(() => updater.close());
    await assert.rejects(updater.start(), error => error.code === (path === 'manifest.json'
      ? 'manifest_checksum_mismatch' : 'artifact_checksum_mismatch'));
    assert.equal(await readlink(join(f.root, 'current')), current);
    assert.equal((await updater.status()).state, 'failed');
    assert.equal(drained, 0);
    assert.equal(resumed, 0);
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
  const { lastError, ...status } = await restarted.status();
  assert.deepEqual(status, { currentVersion: '1.0.0', targetVersion: '1.1.0',
    manifestSha256: f.previous.release.manifestSha256, state: 'rolled-back' });
  assert.match(lastError, /worker_update_startup_timeout/);
  assert.match(lastError, /authenticating/);
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

test('runtime drain blocks maintenance starts until recovery resumes admission', async () => {
  let finishJobs;
  const jobsFinished = new Promise(resolve => { finishJobs = resolve; });
  const drain = createWorkerRuntimeDrain({ signal: new AbortController().signal,
    active: () => [], drainJobs: () => jobsFinished, drainQualifications: async () => {},
    drainMaintenance: async () => {}, quiescent: async () => true });
  const completion = drain.run();
  try {
    assert.throws(() => drain.assertAdmission(COMPUTER_MAINTENANCE_NAMESPACE, { operation: 'start' }),
      { code: 'WORKER_RUNTIME_DRAINING' });
    assert.doesNotThrow(() => drain.assertAdmission(COMPUTER_MAINTENANCE_NAMESPACE, { operation: 'status' }));
  } finally {
    finishJobs();
    await completion;
  }
  assert.throws(() => drain.assertAdmission(COMPUTER_MAINTENANCE_NAMESPACE, { operation: 'start' }),
    { code: 'WORKER_RUNTIME_DRAINING' });
  assert.doesNotThrow(() => drain.assertAdmission(COMPUTER_MAINTENANCE_NAMESPACE, { operation: 'status' }));
  drain.resume();
  assert.doesNotThrow(() => drain.assertAdmission(COMPUTER_MAINTENANCE_NAMESPACE, { operation: 'start' }));
});

test('runtime drain fences workflow and Job admission while allowing status reads', async () => {
  const drained = [];
  const drain = createWorkerRuntimeDrain({ signal: new AbortController().signal,
    active: () => [],
    drainJobs: async () => { drained.push('jobs'); },
    drainQualifications: async () => { drained.push('qualifications'); },
    drainMaintenance: async () => { drained.push('maintenance'); },
    quiescent: async () => true });
  const completion = drain.run();
  for (const method of ['prepare', 'start-turn', 'job-dispatch']) {
    assert.throws(() => drain.assertAdmission('execution-v1', { method }),
      { code: 'WORKER_RUNTIME_DRAINING' });
  }
  assert.doesNotThrow(() => drain.assertAdmission('execution-v1', { method: 'status' }));
  await completion;
  assert.deepEqual(drained, ['jobs', 'qualifications', 'maintenance']);
  assert.throws(() => drain.assertAdmission('execution-v1', { method: 'prepare' }),
    { code: 'WORKER_RUNTIME_DRAINING' });
  drain.resume();
  for (const method of ['prepare', 'start-turn', 'job-dispatch']) {
    assert.doesNotThrow(() => drain.assertAdmission('execution-v1', { method }));
  }
});

test('terminal supervisor failure resumes maintenance Retry only for the unchanged original release', async t => {
  const f = await fixture(t);
  const drain = createWorkerRuntimeDrain({ signal: new AbortController().signal,
    active: () => [], drainJobs: async () => {}, drainQualifications: async () => {},
    drainMaintenance: async () => {}, quiescent: async () => true });
  let resumed = 0;
  const updater = await new WorkerUpdater({ ...f.options, drain: () => drain.run(),
    resume: () => { resumed++; drain.resume(); }, launchSupervisor: async stateDirectory => {
      const record = await readUpdateRecord(stateDirectory);
      record.supervisorStarted = record.restart.requestId;
      await writeUpdateRecord(stateDirectory, record);
    } }).initialize();
  t.after(() => updater.close());
  await updater.start();
  assert.throws(() => drain.assertAdmission(COMPUTER_MAINTENANCE_NAMESPACE, { operation: 'start' }),
    { code: 'WORKER_RUNTIME_DRAINING' });
  let switches = 0;
  await assert.rejects(superviseWorkerUpdate(await readUpdateRecord(f.stateDirectory), {
    prepareService: f.prepareService,
    switchPointer: async () => { switches++; throw new Error('Pointer storage unavailable'); },
    restart: async () => { throw new Error('Restart must not be attempted'); },
  }), { code: 'worker_update_rollback_failed' });
  assert.equal(switches, 2);
  assert.equal((await updater.status()).state, 'failed');
  assert.equal(resumed, 1);
  assert.doesNotThrow(() => drain.assertAdmission(COMPUTER_MAINTENANCE_NAMESPACE, { operation: 'start' }));
  await updater.status();
  assert.equal(resumed, 1);
  assert.equal(await updater.start({ retry: true }), 'Worker 1.1.0 restart is scheduled.');
});

test('terminal supervisor failure cannot resume an ambiguous release pointer', async t => {
  const f = await fixture(t);
  let resumed = 0;
  const updater = await new WorkerUpdater({ ...f.options, resume: () => { resumed++; } }).initialize();
  t.after(() => updater.close());
  await updater.start();
  const record = await readUpdateRecord(f.stateDirectory);
  record.supervisorStarted = record.restart.requestId;
  await writeUpdateRecord(f.stateDirectory, record);
  await assert.rejects(superviseWorkerUpdate(record, {
    prepareService: f.prepareService,
    switchPointer: async () => {
      await rm(record.restart.pointer.path);
      throw new Error('Pointer outcome unavailable');
    },
  }), { code: 'worker_update_rollback_failed' });
  assert.equal((await updater.status()).lastError, 'worker_update_recovery_required');
  assert.equal(resumed, 0);
  await assert.rejects(updater.start({ retry: true }), { code: 'worker_update_recovery_required' });
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
    manifestSha256: f.previous.release.manifestSha256,
    state: 'current', lastError: null });
});

test('an update interrupted by Main restart retries the saved target on the reconnected channel', async t => {
  const f = await fixture(t);
  const originalRequest = f.options.connection().captureRequest().request;
  let available = true;
  let disconnect = true;
  let captures = 0;
  let resumed = 0;
  let launched = 0;
  const options = { ...f.options, resume: () => { resumed++; },
    launchSupervisor: async () => { launched++; },
    connection: () => ({ captureRequest: () => {
      if (!available) return undefined;
      captures++;
      return { request: async payload => {
        if (payload.operation === 'chunk' && disconnect) {
          disconnect = false;
          available = false;
          throw new DeviceConnectionError('transport');
        }
        return originalRequest(payload);
      } };
    } }) };
  const updater = await new WorkerUpdater(options).initialize();
  t.after(() => updater.close());
  await assert.rejects(updater.start(), { code: 'worker_update_channel_unavailable' });
  const interrupted = await readUpdateRecord(f.stateDirectory);
  assert.equal(interrupted.manifestSha256, f.incoming.release.manifestSha256);
  assert.equal(interrupted.status.lastError, 'worker_update_channel_unavailable');
  // The chunk download precedes the drain, so admissions were never fenced.
  assert.equal(resumed, 0);
  assert.equal(launched, 0);
  assert.equal(await updater.start(), 'Worker update is unavailable on this Main connection.');
  available = true;
  updater.ready();
  await until(async () => (await updater.status()).state === 'restarting');
  assert.equal(captures, 2);
  assert.equal(launched, 1);
  assert.equal((await updater.status()).lastError, null);
});

test('reconnection during a failing update schedules a fresh check after the old channel settles', async t => {
  const f = await fixture(t, '1.0.0');
  let rejectRequest;
  let captures = 0;
  const updater = await new WorkerUpdater({ ...f.options, connection: () => ({ captureRequest: () => {
    captures++;
    if (captures === 1) return { request: () => new Promise((_resolve, reject) => { rejectRequest = reject; }) };
    return { request: async () => ({ payload: { operation: 'release', release: f.previous.release } }) };
  } }) }).initialize();
  t.after(() => updater.close());
  const interrupted = assert.rejects(updater.start(), { code: 'worker_update_channel_unavailable' });
  await until(() => rejectRequest !== undefined);
  updater.ready();
  rejectRequest(new DeviceConnectionError('authentication'));
  await interrupted;
  await until(async () => captures === 2 && (await updater.status()).state === 'current');
  assert.equal((await readUpdateRecord(f.stateDirectory)).status.lastError, null);
});

test('a persisted channel failure retries automatically after Worker starts on a connected Main', async t => {
  const f = await fixture(t);
  const interrupted = await new WorkerUpdater({ ...f.options, connection: () => ({ captureRequest: () => ({
    request: async () => { throw new DeviceConnectionError('transport'); },
  }) }) }).initialize();
  await assert.rejects(interrupted.start(), { code: 'worker_update_channel_unavailable' });
  await interrupted.close();
  const updater = await new WorkerUpdater(f.options).initialize();
  t.after(() => updater.close());
  updater.ready();
  await until(async () => (await updater.status()).state === 'restarting');
  assert.equal((await readUpdateRecord(f.stateDirectory)).status.lastError, null);
});

test('application channel loss retries without classifying permission or revocation as channel loss', async t => {
  const cases = [
    { error: new DeviceApplicationError('unavailable'), expected: 'worker_update_channel_unavailable' },
    { error: new DeviceApplicationError('transport'), expected: 'worker_update_channel_unavailable' },
    { error: new DeviceApplicationError('timeout'), expected: 'worker_update_channel_unavailable' },
    { error: new DeviceApplicationError('permission'), expected: 'worker_update_failed' },
    { error: new DeviceConnectionError('revoked'), expected: 'worker_update_failed' },
  ];
  for (const { error, expected } of cases) {
    await t.test(error.code, async t => {
      const f = await fixture(t);
      let connected = false;
      let launched = 0;
      const updater = await new WorkerUpdater({ ...f.options,
        launchSupervisor: async () => { launched++; },
        connection: () => connected ? f.options.connection() : { captureRequest: () => ({
          request: async () => { throw error; },
        }) },
      }).initialize();
      t.after(() => updater.close());
      await assert.rejects(updater.start(), { code: expected });
      const lastError = (await readUpdateRecord(f.stateDirectory)).status.lastError;
      assert.match(lastError, new RegExp(expected));
      if (expected === 'worker_update_failed') assert.match(lastError, new RegExp(error.code));
      assert.equal(launched, 0);
      if (expected === 'worker_update_channel_unavailable') {
        connected = true;
        updater.ready();
        await until(async () => (await updater.status()).state === 'restarting');
        assert.equal(launched, 1);
        assert.equal((await readUpdateRecord(f.stateDirectory)).status.lastError, null);
      }
    });
  }
});

test('reconnection retries a retained generic update failure from before channel errors were classified', async t => {
  const f = await fixture(t);
  await writeUpdateRecord(f.stateDirectory, { format: 1, manifestSha256: f.incoming.release.manifestSha256,
    status: { currentVersion: '1.0.0', targetVersion: '1.1.0', state: 'failed', lastError: 'worker_update_failed' } });
  const updater = await new WorkerUpdater(f.options).initialize();
  t.after(() => updater.close());
  assert.equal(await updater.start(), 'Worker update needs a retry.');
  updater.ready();
  await until(async () => (await updater.status()).state === 'restarting');
  assert.equal((await readUpdateRecord(f.stateDirectory)).status.lastError, null);
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

test('terminal maintenance outcomes identify the release running after success or rollback', async t => {
  for (const rollback of [false, true]) {
    await t.test(rollback ? 'rollback' : 'success', async t => {
      const f = await fixture(t);
      const startedAt = new Date().toISOString();
      const updater = await new WorkerUpdater({ ...f.options, launchSupervisor: async () => {
        await superviseWorkerUpdate(await readUpdateRecord(f.stateDirectory), {
          prepareService: f.prepareService,
          restart: () => f.restart('ready'),
          smoke: async () => {
            if (rollback) throw new Error('CI smoke failed');
          },
        });
      } }).initialize();
      t.after(() => updater.close());
      await updater.start();
      const installed = await readInstalledRelease({ root: f.root, facts, expected });
      assert.deepEqual(await updater.maintenanceOutcome({ workerTargetVersion: '1.1.0', startedAt }), {
        currentVersion: installed.manifest.version,
        manifestSha256: installed.manifestSha256,
        targetVersion: '1.1.0',
        state: rollback ? 'rolled-back' : 'current',
        lastError: rollback ? 'CI smoke failed' : null,
      });
    });
  }
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
    currentVersion: '1.1.0', manifestSha256: release.manifestSha256,
    targetVersion: '1.1.0', state: 'current', lastError: null,
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
test('healthy Worker startup rolls back when its CI setup smoke fails', async t => {
  const f = await fixture(t);
  const updater = await new WorkerUpdater({ ...f.options, launchSupervisor: async () => {
    await superviseWorkerUpdate(await readUpdateRecord(f.stateDirectory), {
      prepareService: f.prepareService,
      restart: () => f.restart('ready'),
      smoke: async () => { throw new Error('CI setup: missing offline package metadata'); },
    });
  } }).initialize();
  t.after(() => updater.close());
  await updater.start();
  assert.equal((await readInstalledRelease({ root: f.root, facts, expected })).manifest.version, '1.0.0');
  const persisted = await readUpdateRecord(f.stateDirectory);
  assert.equal(persisted.status.state, 'rolled-back');
  assert.equal(persisted.status.lastError, 'CI setup: missing offline package metadata');
});

test('Worker update persists authenticated CI smoke configuration and rolls back a setup failure', async t => {
  const f = await fixture(t);
  const configuration = { repository: 'octo/project', commit: f.incoming.release.manifest.commit };
  const captured = f.options.connection().captureRequest();
  const updater = await new WorkerUpdater({ ...f.options,
    connection: () => ({ captureRequest: () => ({ request: payload => payload.operation === 'ci-smoke'
      ? Promise.resolve({ payload: { operation: 'ci-smoke', ciSmoke: configuration } }) : captured.request(payload) }) }),
    launchSupervisor: async () => {
      await superviseWorkerUpdate(await readUpdateRecord(f.stateDirectory), {
        prepareService: f.prepareService, restart: () => f.restart('ready'),
        smoke: async plan => {
          assert.deepEqual(plan.ciSmoke, configuration);
          throw new Error('CI setup: missing offline package metadata');
        },
      });
    },
  }).initialize();
  t.after(() => updater.close());
  await updater.start();
  assert.equal((await readInstalledRelease({ root: f.root, facts, expected })).manifest.version, '1.0.0');
  assert.equal((await readUpdateRecord(f.stateDirectory)).status.lastError, 'CI setup: missing offline package metadata');
});


test('update failure retains the failed phase and child stderr in persisted status', async t => {
  const f = await fixture(t);
  const failure = Object.assign(new Error('staging process exited with code 1'), {
    stderr: 'diagnostic padding\n'.repeat(400) + 'Cannot find package dependency-helper\n',
  });
  const updater = await new WorkerUpdater({ ...f.options, stage: async () => { throw failure; } }).initialize();
  t.after(() => updater.close());
  await assert.rejects(updater.start(), error => {
    assert.equal(error.code, 'worker_update_failed');
    assert.match(error.message, /installing/);
    assert.match(error.message, /Cannot find package dependency-helper/);
    return true;
  });
  const status = (await readUpdateRecord(f.stateDirectory)).status;
  assert.equal(status.state, 'failed');
  assert.match(status.lastError, /staging process exited with code 1/);
  assert.match(status.lastError, /Cannot find package dependency-helper/);
  assert.ok(status.lastError.length <= 2000);
});

test('a stalled bundle download times out, cancels its request and retries on the next check', async t => {
  const f = await fixture(t);
  const request = f.options.connection().captureRequest().request;
  let rejectStalled;
  let downloadSignal;
  let stalled = true;
  const options = { ...f.options, downloadTimeoutMs: 50,
    connection: () => ({ captureRequest: () => ({ request: (payload, requestOptions) => {
      if (stalled && payload.operation === 'chunk') {
        downloadSignal = requestOptions.signal;
        return new Promise((_resolve, reject) => { rejectStalled = reject; });
      }
      return request(payload);
    } }) }) };
  const updater = await new WorkerUpdater(options).initialize();
  t.after(async () => {
    rejectStalled?.(new Error('fixture request closed'));
    await updater.close();
  });
  const outcome = updater.start().then(() => 'completed', error => error);
  const failure = await Promise.race([outcome, wait(1000).then(() => 'still downloading')]);
  assert.equal(failure.code, 'worker_update_download_timeout');
  assert.equal(downloadSignal.aborted, true);
  assert.match((await updater.status()).lastError, /download.*timed out/i);
  stalled = false;
  options.downloadTimeoutMs = 5000;
  updater.scheduleCheck();
  await until(async () => (await updater.status()).state === 'restarting');
  assert.equal((await readUpdateRecord(f.stateDirectory)).status.lastError, null);
});

test('bundle download has a deadline even when individual chunks keep arriving', async t => {
  const f = await fixture(t);
  const request = f.options.connection().captureRequest().request;
  const outcome = downloadWorkerArtifact({ release: f.incoming.release, facts,
    directory: join(f.base, 'bounded-download'), timeoutMs: 15,
    request: async payload => { await wait(25); return request(payload); },
  }).then(() => 'completed', error => error);
  const failure = await outcome;
  assert.equal(failure.code, 'worker_update_download_timeout');
});

test('startup timeout retains the last observed readiness phase and failure', async () => {
  await assert.rejects(waitForWorkerReady({ stateDirectory: '/fixture/state', version: '1.1.0',
    workerInstallationId: randomUUID(), timeoutMs: 5, pollMs: 1,
    readStatus: async () => ({ active: true, phase: 'backoff', failure: 'authentication', appVersion: '1.1.0' }),
  }), error => {
    assert.equal(error.code, 'worker_update_startup_timeout');
    assert.match(error.message, /backoff/);
    assert.match(error.message, /authentication/);
    return true;
  });
});

test('supervisor preserves restart stderr and both update and rollback readiness failures', async t => {
  const f = await fixture(t);
  const updater = await new WorkerUpdater(f.options).initialize();
  t.after(() => updater.close());
  await updater.start();
  const record = await readUpdateRecord(f.stateDirectory);
  let attempts = 0;
  await assert.rejects(superviseWorkerUpdate(record, {
    prepareService: async () => {}, switchPointer: async () => {},
    restart: async () => {
      if (++attempts === 1) throw Object.assign(new Error('restart exited 1'), { stderr: 'runtime library missing' });
    },
    ready: async () => { throw new Error('rollback authentication failed'); },
  }), { code: 'worker_update_rollback_failed' });
  const status = (await readUpdateRecord(f.stateDirectory)).status;
  assert.equal(status.state, 'failed');
  assert.match(status.lastError, /runtime library missing/);
  assert.match(status.lastError, /rollback authentication failed/);
});


test('GitHub asset download reports the command stderr tail', async t => {
  const f = await fixture(t);
  const binary = join(f.base, 'gh');
  await writeFile(binary, '#!/bin/sh\nprintf "release asset not found\\n" >&2\nexit 1\n', { mode: 0o700 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${f.base}:${originalPath}`;
  t.after(() => { process.env.PATH = originalPath; });
  await assert.rejects(fetchGitHubAsset({ github: { repository: 'example/product', tag: `worker-${'a'.repeat(40)}` },
    asset: 'artifact.tar.gz', destination: join(f.base, 'download.tar.gz'), maxBytes: 1024,
  }), error => {
    assert.equal(error.code, 'worker_update_github_unavailable');
    assert.match(error.message, /release asset not found/);
    return true;
  });
});

test('supervisor readiness failure captures startup stderr before rollback', async t => {
  const f = await fixture(t);
  const updater = await new WorkerUpdater(f.options).initialize();
  t.after(() => updater.close());
  await updater.start();
  let readinessChecks = 0;
  let logReads = 0;
  await superviseWorkerUpdate(await readUpdateRecord(f.stateDirectory), {
    prepareService: async () => {}, switchPointer: async () => {}, restart: async () => {},
    ready: async () => { if (++readinessChecks === 1) throw new WorkerError('worker_update_startup_timeout'); },
    readStartupFailure: async () => { logReads++; return 'Cannot find module startup-helper'; },
  });
  assert.equal(logReads, 1);
  const status = (await readUpdateRecord(f.stateDirectory)).status;
  assert.equal(status.state, 'rolled-back');
  assert.match(status.lastError, /Cannot find module startup-helper/);
});
