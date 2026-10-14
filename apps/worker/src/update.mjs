import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { WorkerArtifactManifestSchema, WorkerArtifactReplySchema, WorkerUpdateStatusSchema,
  WORKER_UPDATE_NAMESPACE, WORKER_UPDATE_VERSION, WORKER_UPDATE_MAX_BINARY_BYTES,
  WORKER_UPDATE_MAX_JSON_BYTES } from '../../../packages/contracts/src/workerUpdate.ts';
import { readWorkerSmokeConfiguration } from './ciInstallSmoke.mjs';
import { WorkerError, workerUpdateErrorMessage } from './diagnostics.mjs';
import { validateManifest, stageRunningVersion } from './installation.mjs';
import { readUpdateRecord, writeUpdateRecord, locateWorkerLaunch, launchUpdateSupervisor,
  workerPointerMatches } from './updateSupervisor.mjs';
import { DeviceConnectionError } from '../../../apps/api/src/modules/devices/deviceWire.ts';
import { DeviceApplicationError } from '../../../apps/api/src/modules/devices/deviceApplicationError.ts';
import { extractWorkerArchive, fetchGitHubAsset, workerArchiveLimits, requireArchiveCapacity }
  from './workerArtifactArchive.mjs';

export { fetchGitHubAsset };

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const expected = { protocolVersion: 1, identityFormat: 1 };
const automaticRetryErrors = new Set(['worker_update_interrupted', 'worker_updater_stopped',
  'worker_update_channel_unavailable', 'worker_update_download_timeout', 'worker_update_github_unavailable',
  'worker_update_smoke_unavailable']);

export const workerUpdateExtension = { namespace: WORKER_UPDATE_NAMESPACE, version: WORKER_UPDATE_VERSION,
  role: 'client', maxJsonBytes: WORKER_UPDATE_MAX_JSON_BYTES, maxBinaryBytes: WORKER_UPDATE_MAX_BINARY_BYTES };

/** The release asset is only a carrier: every installed byte is still checked against the announced manifest. */
async function downloadFromGitHub({ release, announced, directory, signal, fetchAsset }) {
  const scratch = await mkdtemp(join(dirname(directory), '.worker-github-'));
  try {
    const archive = join(scratch, 'artifact.tar.gz');
    const limits = workerArchiveLimits(announced);
    await requireArchiveCapacity(scratch, limits);
    await fetchAsset({ github: release.github, asset: `${release.manifestSha256}.tar.gz`, destination: archive,
      signal, maxBytes: limits.compressedBytes });
    return await extractWorkerArchive({ archive, announced, release, directory, limits, signal });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function requestDownloadChunk(request, payload, signal) {
  signal.throwIfAborted();
  let rejectAborted;
  const aborted = new Promise((_, reject) => { rejectAborted = reject; });
  const cancel = () => rejectAborted(signal.reason);
  signal.addEventListener('abort', cancel, { once: true });
  try {
    return await Promise.race([request(payload, { signal }), aborted]);
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

export async function downloadWorkerArtifact({ signal, timeoutMs = 600_000, ...options }) {
  const deadline = new AbortController();
  const combined = AbortSignal.any([deadline.signal, ...(signal ? [signal] : [])]);
  const timer = setTimeout(() => deadline.abort(new WorkerError('worker_update_download_timeout',
    `Worker bundle download timed out after ${timeoutMs} ms.`)), timeoutMs);
  try {
    return await downloadArtifactFiles({ ...options, signal: combined });
  } catch (error) {
    combined.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function downloadArtifactFiles({ release, request, directory, facts, signal, fetchAsset = fetchGitHubAsset }) {
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
      const response = await requestDownloadChunk(request,
        { operation: 'chunk', manifestSha256: release.manifestSha256, path, offset }, signal);
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
    this.statusValue = { currentVersion: options.version, manifestSha256: options.manifestSha256,
      targetVersion: null, state: 'current', lastError: null };
  }

  async initialize() {
    const retained = await readUpdateRecord(this.options.stateDirectory);
    if (retained) {
      this.record = retained;
      this.statusValue = WorkerUpdateStatusSchema.parse({ ...retained.status, currentVersion: this.options.version,
        manifestSha256: this.options.manifestSha256 });
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
        this.statusValue = WorkerUpdateStatusSchema.parse({ ...retained.status, currentVersion: this.options.version,
          manifestSha256: this.options.manifestSha256 });
        await this.recoverAdmission(retained);
      }
      return { ...this.statusValue };
    });
  }

  async recoverAdmission(record) {
    const plan = record.restart;
    if (!this.handoff || record.status.state !== 'failed' || plan?.requestId !== this.handoff
      || record.supervisorStarted !== this.handoff
      || !record.outcomes?.some(outcome => outcome.requestId === this.handoff && outcome.status.state === 'failed')) return;
    this.options.assertStateOwnership();
    const unchanged = plan.restartAttempted === false
      && plan.previousVersion === this.options.version
      && plan.workerInstallationId === this.options.workerInstallationId
      && plan.previousDirectory === this.options.releaseDirectory
      && await workerPointerMatches(plan.pointer, this.options.releaseDirectory);
    this.options.assertStateOwnership();
    if (unchanged) {
      this.options.resume();
      this.handoff = undefined;
      return;
    }
    this.statusValue = { ...this.statusValue, lastError: 'worker_update_recovery_required' };
  }

  save(change, details = {}) {
    return this.withUpdateRecord(async () => {
      this.options.assertStateOwnership();
      this.statusValue = WorkerUpdateStatusSchema.parse({ ...this.statusValue, ...change,
        manifestSha256: this.options.manifestSha256 });
      const retained = await readUpdateRecord(this.options.stateDirectory);
      this.record = { ...retained, ...details, format: 1, status: this.statusValue };
      if (this.statusValue.lastError === null) delete this.record.failureCode;
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

  retryableFailure() {
    return automaticRetryErrors.has(this.record?.failureCode ?? this.statusValue.lastError);
  }

  async update(retry) {
    const { stateDirectory, version, facts, connection, drain, resume, assertStateOwnership } = this.options;
    await this.status();
    this.lifetime.signal.throwIfAborted();
    if (this.statusValue.state === 'restarting') throw new WorkerError('worker_update_restart_pending');
    if (this.statusValue.lastError === 'worker_update_recovery_required') {
      throw new WorkerError('worker_update_recovery_required');
    }
    const captured = connection()?.captureRequest(WORKER_UPDATE_NAMESPACE);
    if (!captured) {
      if (retry) throw new WorkerError('worker_update_channel_unavailable');
      return 'Worker update is unavailable on this Main connection.';
    }
    const request = async (payload, options = {}) => {
      try {
        const signal = options.signal ? AbortSignal.any([this.lifetime.signal, options.signal]) : this.lifetime.signal;
        return await captured.request(payload, { timeoutMs: 60_000, signal });
      } catch (error) {
        if (error instanceof DeviceApplicationError && error.code === 'WORKER_UPDATE_SMOKE_UNAVAILABLE') {
          throw new WorkerError('worker_update_smoke_unavailable',
            'Main cannot supply CI smoke configuration for this Worker release.');
        }
        const channelLost = error instanceof DeviceConnectionError && error.code !== 'revoked'
          || error instanceof DeviceApplicationError && ['unavailable', 'transport', 'timeout'].includes(error.code);
        if (channelLost) throw new WorkerError('worker_update_channel_unavailable');
        throw error;
      }
    };
    const target = Object.fromEntries(['os', 'osRelease', 'arch', 'libc', 'node'].map(key => [key, facts[key]]));
    let downloading;
    let phase = 'release';
    let drained = false;
    try {
      const response = await request({ operation: 'release', target });
      const reply = WorkerArtifactReplySchema.parse(response.payload);
      if (reply.operation !== 'release' || response.bytes !== undefined) throw new WorkerError('artifact_release_invalid');
      if (!reply.release) throw new WorkerError('worker_update_target_unavailable');
      const release = reply.release;
      if (release.version === version && release.manifestSha256 === this.options.manifestSha256) {
        if (retry || this.retryableFailure()
          || !['rolled-back', 'failed'].includes(this.statusValue.state)) {
          await this.save({ targetVersion: version, state: 'current', lastError: null });
        }
        return `Worker ${version} is current.`;
      }
      // Connection loss and interrupted shutdowns are safe to retry from the release manifest.
      if (!retry && this.record?.manifestSha256 === release.manifestSha256
        && ['failed', 'rolled-back'].includes(this.statusValue.state)
        && !this.retryableFailure()) {
        return 'Worker update needs a retry.';
      }
      const launch = await (this.options.locateLaunch ?? locateWorkerLaunch)(this.options);
      await this.save({ targetVersion: release.version, state: 'pending', lastError: null },
        { manifestSha256: release.manifestSha256 });
      // Download and verify while the Worker still admits work: through Main this can take minutes.
      // Only installation and restart need the drained runtime.
      phase = 'downloading';
      await this.save({ state: 'downloading' });
      downloading = await mkdtemp(join(stateDirectory, '.worker-download-'));
      await downloadWorkerArtifact({ release, request, directory: downloading, facts, signal: this.lifetime.signal,
        timeoutMs: this.options.downloadTimeoutMs });
      this.lifetime.signal.throwIfAborted();
      phase = 'smoke configuration';
      const ciSmoke = await readWorkerSmokeConfiguration(request, release.manifestSha256);
      phase = 'draining';
      await this.save({ state: 'draining' });
      drained = true;
      await drain();
      this.lifetime.signal.throwIfAborted();
      assertStateOwnership();
      phase = 'installing';
      await this.save({ state: 'installing' });
      const installed = await (this.options.stage ?? stageRunningVersion)({ root: launch.root, stateDirectory,
        artifact: downloading, approvedManifestSha256: release.manifestSha256, facts, expected,
        assertStateOwnership, updatePolicy: async () => true });
      this.lifetime.signal.throwIfAborted();
      assertStateOwnership();
      this.handoff = randomUUID();
      await this.save({ state: 'restarting' }, { restart: { ...launch, directory: installed.directory,
        ...(ciSmoke ? { ciSmoke } : {}),
        requestId: this.handoff, restartAttempted: false, previousVersion: version,
        workerInstallationId: this.options.workerInstallationId } });
      phase = 'restarting';
      await (this.options.launchSupervisor ?? launchUpdateSupervisor)(stateDirectory);
      return `Worker ${release.version} restart is scheduled.`;
    } catch (error) {
      const failureCode = this.lifetime.signal.aborted ? 'worker_updater_stopped'
        : error instanceof WorkerError ? error.code : 'worker_update_failed';
      const lastError = error instanceof WorkerError && error.message === error.code ? failureCode
        : `${failureCode}: ${phase}: ${workerUpdateErrorMessage(error)}`.slice(0, 2000);
      await this.save({ state: 'failed', lastError }, { failureCode });
      if (drained) resume();
      throw new WorkerError(failureCode, lastError, { cause: error });
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
