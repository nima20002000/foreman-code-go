import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { WorkerArtifactManifestSchema, WorkerArtifactReplySchema, WorkerUpdateStatusSchema,
  WORKER_UPDATE_NAMESPACE, WORKER_UPDATE_VERSION, WORKER_UPDATE_MAX_BINARY_BYTES,
  WORKER_UPDATE_MAX_JSON_BYTES } from '../../../packages/contracts/src/workerUpdate.ts';
import { WorkerError } from './diagnostics.mjs';
import { validateManifest, stageRunningVersion } from './installation.mjs';
import { readUpdateRecord, writeUpdateRecord, locateWorkerLaunch, launchUpdateSupervisor } from './updateSupervisor.mjs';
import { DeviceConnectionError } from '../../../apps/api/src/modules/devices/deviceWire.ts';
import { DeviceApplicationError } from '../../../apps/api/src/modules/devices/deviceApplicationError.ts';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const expected = { protocolVersion: 1, identityFormat: 1 };
const automaticRetryErrors = new Set(['worker_update_interrupted', 'worker_updater_stopped',
  'worker_update_channel_unavailable']);

export const workerUpdateExtension = { namespace: WORKER_UPDATE_NAMESPACE, version: WORKER_UPDATE_VERSION,
  role: 'client', maxJsonBytes: WORKER_UPDATE_MAX_JSON_BYTES, maxBinaryBytes: WORKER_UPDATE_MAX_BINARY_BYTES };

const runCommand = (file, args, signal) => new Promise((resolve, reject) => {
  execFile(file, args, { signal, timeout: 600_000, maxBuffer: 1024 * 1024 }, error => error ? reject(error) : resolve());
});

/** Downloads <manifestSha256>.tar.gz from the release's GitHub release with this computer's gh login. */
export async function fetchGitHubAsset({ github, asset, destination, signal }) {
  await runCommand('gh', ['release', 'download', github.tag, '--repo', github.repository, '--pattern', asset,
    '--output', destination], signal).catch(() => { throw new WorkerError('worker_update_github_unavailable'); });
}

/** The release asset is only a carrier: every installed byte is still checked against the announced manifest. */
async function downloadFromGitHub({ release, announced, directory, signal, fetchAsset }) {
  const scratch = await mkdtemp(join(dirname(directory), '.worker-github-'));
  try {
    const archive = join(scratch, 'artifact.tar.gz'), extracted = join(scratch, 'artifact');
    await mkdir(extracted, { mode: 0o700 });
    await fetchAsset({ github: release.github, asset: `${release.manifestSha256}.tar.gz`, destination: archive, signal });
    await runCommand('tar', ['-xzf', archive, '-C', extracted, '--no-same-owner', '--no-same-permissions'], signal)
      .catch(() => { throw new WorkerError('artifact_archive_invalid'); });
    const manifestBytes = await readFile(join(extracted, 'manifest.json'));
    if (hash(manifestBytes) !== release.manifestSha256) throw new WorkerError('manifest_checksum_mismatch');
    const manifest = WorkerArtifactManifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')));
    if (!isDeepStrictEqual(manifest, announced)) throw new WorkerError('manifest_metadata_mismatch');
    await writeFile(join(directory, 'manifest.json'), manifestBytes, { mode: 0o600 });
    for (const file of manifest.files) {
      signal?.throwIfAborted();
      const bytes = await readFile(join(extracted, file.path));
      if (bytes.length !== file.size || hash(bytes) !== file.sha256) throw new WorkerError('artifact_checksum_mismatch');
      const path = join(directory, file.path);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, bytes, { mode: 0o600 });
    }
    return manifest;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function downloadWorkerArtifact({ release, request, directory, facts, signal, fetchAsset = fetchGitHubAsset }) {
  const announced = WorkerArtifactManifestSchema.parse(release.manifest);
  validateManifest(announced, facts, expected);
  if (announced.version !== release.version) throw new WorkerError('manifest_version_mismatch');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Main names a GitHub release: download from GitHub, which is far faster than chunks through Main.
  if (release.github) return downloadFromGitHub({ release, announced, directory, signal, fetchAsset });
  const download = async (path, size) => {
    const chunks = [];
    let offset = 0;
    for (;;) {
      signal?.throwIfAborted();
      const response = await request({ operation: 'chunk', manifestSha256: release.manifestSha256, path, offset });
      const payload = WorkerArtifactReplySchema.parse(response.payload);
      const bytes = response.bytes;
      if (payload.operation !== 'chunk' || payload.manifestSha256 !== release.manifestSha256
        || payload.path !== path || payload.offset !== offset || !(bytes instanceof Uint8Array)
        || payload.byteSize !== bytes.byteLength) throw new WorkerError('artifact_chunk_invalid');
      if (offset + bytes.byteLength > size) throw new WorkerError('artifact_file_size_mismatch');
      chunks.push(Buffer.from(bytes));
      offset += bytes.byteLength;
      if (bytes.byteLength === 0 || offset === size || path === 'manifest.json'
        && bytes.byteLength < WORKER_UPDATE_MAX_BINARY_BYTES) break;
    }
    return Buffer.concat(chunks);
  };
  const manifestBytes = await download('manifest.json', WORKER_UPDATE_MAX_JSON_BYTES);
  if (hash(manifestBytes) !== release.manifestSha256) throw new WorkerError('manifest_checksum_mismatch');
  const manifest = WorkerArtifactManifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')));
  if (!isDeepStrictEqual(manifest, announced)) throw new WorkerError('manifest_metadata_mismatch');
  await writeFile(join(directory, 'manifest.json'), manifestBytes, { mode: 0o600 });
  for (const file of manifest.files) {
    const bytes = file.size ? await download(file.path, file.size) : Buffer.alloc(0);
    if (bytes.length !== file.size || hash(bytes) !== file.sha256) throw new WorkerError('artifact_checksum_mismatch');
    const path = join(directory, file.path);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, bytes, { mode: 0o600 });
  }
  return manifest;
}

export class WorkerUpdater {
  constructor(options) {
    this.options = options;
    this.active = undefined;
    this.timer = undefined;
    this.closed = false;
    this.lifetime = new AbortController();
    this.recordOperation = Promise.resolve();
    this.statusValue = { currentVersion: options.version, targetVersion: null, state: 'current', lastError: null };
  }

  async initialize() {
    const retained = await readUpdateRecord(this.options.stateDirectory);
    if (retained) {
      this.record = retained;
      this.statusValue = WorkerUpdateStatusSchema.parse({ ...retained.status, currentVersion: this.options.version });
      if (['pending', 'draining', 'downloading', 'installing'].includes(this.statusValue.state)) {
        await this.save({ state: 'failed', lastError: 'worker_update_interrupted' });
      }
    } else {
      await this.save({});
    }
    return this;
  }

  withUpdateRecord(operation) {
    // Serialize reads with writes so polling cannot replace a status being saved.
    const result = this.recordOperation.then(operation, operation);
    this.recordOperation = result;
    return result;
  }

  status() {
    return this.withUpdateRecord(async () => {
      const retained = await readUpdateRecord(this.options.stateDirectory);
      if (retained) {
        this.record = retained;
        this.statusValue = WorkerUpdateStatusSchema.parse({ ...retained.status, currentVersion: this.options.version });
      }
      return { ...this.statusValue };
    });
  }

  save(change, details = {}) {
    return this.withUpdateRecord(async () => {
      this.options.assertStateOwnership();
      this.statusValue = WorkerUpdateStatusSchema.parse({ ...this.statusValue, ...change });
      const retained = await readUpdateRecord(this.options.stateDirectory);
      this.record = { ...retained, ...details, format: 1, status: this.statusValue };
      await writeUpdateRecord(this.options.stateDirectory, this.record);
    });
  }

  async maintenanceOutcome(task) {
    const record = await readUpdateRecord(this.options.stateDirectory);
    const outcome = (record?.outcomes ?? []).find(value => value.status.targetVersion === task.workerTargetVersion
      && Date.parse(value.finishedAt) >= Date.parse(task.startedAt));
    return outcome ? WorkerUpdateStatusSchema.parse(outcome.status) : null;
  }

  ready() {
    if (this.closed) return;
    this.pendingReadyCheck = true;
    this.scheduleCheck();
    this.timer ??= setInterval(() => this.scheduleCheck(), this.options.checkIntervalMs ?? 60_000);
    this.timer.unref();
  }

  scheduleCheck() {
    if (this.active || this.closed) return;
    const reconnected = this.pendingReadyCheck;
    this.pendingReadyCheck = false;
    void this.status().then(status => {
      if (status.state !== 'restarting') {
        return this.start({ retry: Boolean(reconnected && status.lastError === 'worker_update_failed') });
      }
    }).catch(error => this.options.reportError?.(error));
  }

  start({ retry = false } = {}) {
    if (this.active) return this.active;
    if (this.closed) return Promise.reject(new WorkerError('worker_updater_closed'));
    const task = this.update(retry);
    this.active = task;
    const finished = () => {
      this.active = undefined;
      if (this.pendingReadyCheck) this.scheduleCheck();
    };
    void task.then(finished, finished);
    return task;
  }

  async update(retry) {
    const { stateDirectory, version, facts, connection, drain, resume, assertStateOwnership } = this.options;
    await this.status();
    this.lifetime.signal.throwIfAborted();
    if (this.statusValue.state === 'restarting') throw new WorkerError('worker_update_restart_pending');
    const captured = connection()?.captureRequest(WORKER_UPDATE_NAMESPACE);
    if (!captured) {
      if (retry) throw new WorkerError('worker_update_channel_unavailable');
      return 'Worker update is unavailable on this Main connection.';
    }
    const request = async payload => {
      try {
        return await captured.request(payload, { timeoutMs: 60_000, signal: this.lifetime.signal });
      } catch (error) {
        const channelLost = error instanceof DeviceConnectionError && error.code !== 'revoked'
          || error instanceof DeviceApplicationError && ['unavailable', 'transport', 'timeout'].includes(error.code);
        if (channelLost) throw new WorkerError('worker_update_channel_unavailable');
        throw error;
      }
    };
    const target = Object.fromEntries(['os', 'osRelease', 'arch', 'libc', 'node'].map(key => [key, facts[key]]));
    let downloading;
    let drained = false;
    try {
      const response = await request({ operation: 'release', target });
      const reply = WorkerArtifactReplySchema.parse(response.payload);
      if (reply.operation !== 'release' || response.bytes !== undefined) throw new WorkerError('artifact_release_invalid');
      if (!reply.release) throw new WorkerError('worker_update_target_unavailable');
      const release = reply.release;
      if (release.version === version && release.manifestSha256 === this.options.manifestSha256) {
        if (retry || automaticRetryErrors.has(this.statusValue.lastError)
          || !['rolled-back', 'failed'].includes(this.statusValue.state)) {
          await this.save({ targetVersion: version, state: 'current', lastError: null });
        }
        return `Worker ${version} is current.`;
      }
      // Connection loss and interrupted shutdowns are safe to retry from the release manifest.
      if (!retry && this.record?.manifestSha256 === release.manifestSha256
        && ['failed', 'rolled-back'].includes(this.statusValue.state)
        && !automaticRetryErrors.has(this.statusValue.lastError)) {
        return 'Worker update needs a retry.';
      }
      const launch = await (this.options.locateLaunch ?? locateWorkerLaunch)(this.options);
      await this.save({ targetVersion: release.version, state: 'pending', lastError: null },
        { manifestSha256: release.manifestSha256 });
      await this.save({ state: 'draining' });
      drained = true;
      await drain();
      this.lifetime.signal.throwIfAborted();
      assertStateOwnership();
      await this.save({ state: 'downloading' });
      downloading = await mkdtemp(join(stateDirectory, '.worker-download-'));
      await downloadWorkerArtifact({ release, request, directory: downloading, facts, signal: this.lifetime.signal });
      this.lifetime.signal.throwIfAborted();
      await this.save({ state: 'installing' });
      const installed = await (this.options.stage ?? stageRunningVersion)({ root: launch.root, stateDirectory,
        artifact: downloading, approvedManifestSha256: release.manifestSha256, facts, expected,
        assertStateOwnership, updatePolicy: async () => true });
      this.lifetime.signal.throwIfAborted();
      assertStateOwnership();
      await this.save({ state: 'restarting' }, { restart: { ...launch, directory: installed.directory,
        requestId: randomUUID(), previousVersion: version, workerInstallationId: this.options.workerInstallationId } });
      await (this.options.launchSupervisor ?? launchUpdateSupervisor)(stateDirectory);
      return `Worker ${release.version} restart is scheduled.`;
    } catch (error) {
      const lastError = this.lifetime.signal.aborted ? 'worker_updater_stopped'
        : error instanceof WorkerError ? error.code : 'worker_update_failed';
      await this.save({ state: 'failed', lastError });
      if (drained) resume();
      throw new WorkerError(lastError);
    } finally {
      if (downloading) await rm(downloading, { recursive: true, force: true });
    }
  }

  close() {
    this.closed = true;
    clearInterval(this.timer);
    this.lifetime.abort(new WorkerError('worker_updater_stopped'));
    return this.active?.then(() => {}, error => this.options.reportError?.(error));
  }
}
