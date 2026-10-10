import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, lstat, realpath, copyFile, chmod, open, rename, symlink, readlink, rm, statfs } from 'node:fs/promises';
import { join, dirname, basename, isAbsolute } from 'node:path';
import { WorkerError, requirePrivateDirectory } from './diagnostics.mjs';
import { acquireWorkerLock } from './runtime.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const digest = /^[a-f0-9]{64}$/;
const version = /^\d+\.\d+\.\d+$/;
export function validateManifest(manifest, facts, expected) {
  if (manifest.format !== 1 || !version.test(manifest.version) || !/^[a-f0-9]{40}$/.test(manifest.commit) || !digest.test(manifest.lockfileSha256) || !manifest.target) throw new WorkerError('manifest_invalid');
  if (manifest.protocolVersion !== expected.protocolVersion || manifest.identityFormat !== expected.identityFormat) throw new WorkerError('protocol_or_identity_unsupported');
  if (facts.os !== 'ubuntu' || manifest.target.os !== facts.os || manifest.target.osRelease !== facts.osRelease || manifest.target.arch !== facts.arch || manifest.target.libc !== facts.libc || manifest.target.node !== facts.node) throw new WorkerError('target_runtime_mismatch');
  if (!facts.rootPersistent || !facts.homePersistent || facts.storagePersistent === false) throw new WorkerError('nonpersistent_storage');
  if (manifest.packageManager !== 'pnpm@11.27.0' || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 512) throw new WorkerError('manifest_invalid');
  const names = new Set();
  for (const file of manifest.files) {
    if (!/^[a-zA-Z0-9_@./-]+$/.test(file.path) || file.path.startsWith('/') || file.path.split('/').some((part) => !part || part === '.' || part === '..') || !digest.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > 64 * 1024 * 1024 || names.has(file.path)) throw new WorkerError('manifest_invalid');
    names.add(file.path);
  }
  if (!names.has('src/cli.mjs')) throw new WorkerError('entrypoint_missing');
}

async function switchLink(root, name, target) {
  const temporary = join(root, `.${name}-${randomUUID()}`);
  try { await symlink(target, temporary); await rename(temporary, join(root, name)); await syncDirectory(root); }
  finally { await rm(temporary, { force: true }); }
}

async function syncDirectory(path) {
  const handle = await open(path, 'r'); try { await handle.sync(); } finally { await handle.close(); }
}

async function syncArtifactDirectories(stage, files) {
  const directories = new Set([stage]);
  for (const file of files) {
    let directory = dirname(join(stage, file.path));
    while (directory !== stage) {
      directories.add(directory);
      directory = dirname(directory);
    }
  }
  // Persist child entries before making their parent directory reachable.
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
    await syncDirectory(directory);
  }
}

async function verifyRelease(directory, approvedHash) {
  await requirePrivateDirectory(directory);
  const bytes = await readFile(join(directory, 'manifest.json'));
  if (hash(bytes) !== approvedHash) throw new WorkerError('installation_invalid');
  const manifest = JSON.parse(bytes);
  const base = await realpath(directory);
  for (const file of manifest.files) {
    const source = join(directory, file.path);
    if (!(await lstat(source)).isFile() || !(await realpath(source)).startsWith(`${base}/`)) throw new WorkerError('artifact_file_invalid');
    const content = await readFile(source);
    if (hash(content) !== file.sha256 || content.length !== file.size) throw new WorkerError('artifact_checksum_mismatch');
  }
  return manifest;
}

export async function readInstalledRelease({ root, facts, expected }) {
  await requirePrivateDirectory(root);
  const current = await readlink(join(root, 'current'));
  if (!/^versions\/\d+\.\d+\.\d+-[a-f0-9]{64}$/.test(current)) throw new WorkerError('installation_invalid');
  const manifestSha256 = current.slice(-64);
  const manifest = await verifyRelease(join(root, current), manifestSha256);
  validateManifest(manifest, facts, expected);
  return { manifest, manifestSha256, directory: join(root, current) };
}

export async function withInstallLock(root, fn) {
  const created = await mkdir(root, { recursive: true, mode: 0o700 });
  await requirePrivateDirectory(root);
  if (created) {
    const parent = dirname(created);
    let directory = root;
    while (directory !== parent) {
      await syncDirectory(directory);
      directory = dirname(directory);
    }
    await syncDirectory(parent);
  }
  const lock = join(root, '.install-lock');
  try { await mkdir(lock, { mode: 0o700 }); } catch (error) { if (error.code === 'EEXIST') throw new WorkerError('install_busy'); throw error; }
  try { return await fn(); } finally { await rm(lock, { recursive: true, force: true }); }
}

async function installationState(root, stateDirectory) {
  if (!isAbsolute(stateDirectory ?? '')) throw new WorkerError('separate_private_roots_required');
  await requirePrivateDirectory(root);
  await requirePrivateDirectory(stateDirectory);
  const app = await realpath(root);
  const state = await realpath(stateDirectory);
  if (app === state || app.startsWith(`${state}/`) || state.startsWith(`${app}/`)) {
    throw new WorkerError('separate_private_roots_required');
  }
  return state;
}

export async function requireInstallationState({ root, stateDirectory }) {
  const state = await installationState(root, stateDirectory);
  const path = join(root, 'state-directory.json');
  let binding;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077)) {
      throw new WorkerError('installation_invalid');
    }
    binding = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new WorkerError('installation_state_unbound');
    throw error;
  }
  if (binding.format !== 1 || binding.stateDirectory !== state) {
    throw new WorkerError('installation_state_mismatch');
  }
  return state;
}

export async function requireReleaseState({ directory, stateDirectory }) {
  const release = await realpath(directory);
  const versions = dirname(release);
  if (basename(versions) === 'versions' && /^\d+\.\d+\.\d+-[a-f0-9]{64}$/.test(basename(release))) {
    await requireInstallationState({ root: dirname(versions), stateDirectory });
  }
}

async function bindInstallationState(root, stateDirectory) {
  const handle = await open(join(root, 'state-directory.json'), 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ format: 1, stateDirectory })}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(root);
}

async function prepareInstallation(root, stateDirectory) {
    const state = await installationState(root, stateDirectory);
    let bound = true;
    try {
      await requireInstallationState({ root, stateDirectory });
    } catch (error) {
      if (error.code !== 'installation_state_unbound') throw error;
      try {
        await lstat(join(root, 'current'));
      } catch (failure) {
        if (failure.code !== 'ENOENT') throw failure;
        bound = false;
      }
      if (bound) throw error;
    }
    return { state, bound };
}

export async function installVersion(options) {
  const { root, stateDirectory, publishInstallation } = options;
  return withInstallLock(root, async () => {
    const { state, bound } = await prepareInstallation(root, stateDirectory);
    const unlock = await acquireWorkerLock(state);
    try {
      const result = await installRelease(options, state, bound);
      if (publishInstallation) await publishInstallation(result);
      return result;
    } finally {
      await unlock();
    }
  });
}

export async function stageRunningVersion(options) {
  return withInstallLock(options.root, async () => {
    options.assertStateOwnership();
    const { state, bound } = await prepareInstallation(options.root, options.stateDirectory);
    const result = await installRelease({ ...options, stageOnly: true }, state, bound);
    options.assertStateOwnership();
    return result;
  });
}

async function installRelease({ root, artifact, approvedManifestSha256, facts, expected, updatePolicy, stageOnly }, state, bound) {
  const bytes = await readFile(join(artifact, 'manifest.json'));
  if (!digest.test(approvedManifestSha256) || hash(bytes) !== approvedManifestSha256) throw new WorkerError('manifest_checksum_mismatch');
  const manifest = JSON.parse(bytes);
  validateManifest(manifest, facts, expected);
  let current;
  try { current = await readlink(join(root, 'current')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (current) {
    if (!/^versions\/\d+\.\d+\.\d+-[a-f0-9]{64}$/.test(current)) throw new WorkerError('installation_invalid');
    if (hash(await readFile(join(root, current, 'manifest.json'))) === approvedManifestSha256) {
      await verifyRelease(join(root, current), approvedManifestSha256);
      return { version: manifest.version, manifestSha256: approvedManifestSha256,
        directory: join(root, current) };
    }
    const previous = JSON.parse(await readFile(join(root, current, 'manifest.json'), 'utf8'));
    if (!stageOnly && manifest.version === previous.version && manifest.commit !== previous.commit) {
      throw new WorkerError('release_order_unknown');
    }
    const incoming = manifest.version.split('.').map(Number), installed = previous.version.split('.').map(Number);
    const differing = incoming.findIndex((n, i) => n !== installed[i]);
    if (!stageOnly && differing >= 0 && incoming[differing] < installed[differing]) throw new WorkerError('downgrade_refused');
    if (!updatePolicy || await updatePolicy({ from: previous.version, to: manifest.version }) !== true) throw new WorkerError('update_not_approved');
  }
  const releases = join(root, 'versions');
  await mkdir(releases, { recursive: true, mode: 0o700 });
  await requirePrivateDirectory(releases);
  const disk = await statfs(root);
  if (disk.bavail * disk.bsize < manifest.files.reduce((sum, file) => sum + file.size, bytes.length) + 1024 * 1024) throw new WorkerError('disk_full');
  const stage = join(releases, `.stage-${randomUUID()}`);
  await mkdir(stage, { mode: 0o700 });
  try {
    const base = await realpath(artifact);
    for (const file of manifest.files) {
      const source = join(artifact, file.path);
      const info = await lstat(source);
      if (!info.isFile() || info.isSymbolicLink() || !(await realpath(source)).startsWith(`${base}/`)) throw new WorkerError('artifact_file_invalid');
      const content = await readFile(source);
      if (content.length !== file.size || hash(content) !== file.sha256) throw new WorkerError('artifact_checksum_mismatch');
      const target = join(stage, file.path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(source, target);
      // Verify copied bytes as well, closing source mutation between verification and copy.
      if (hash(await readFile(target)) !== file.sha256) throw new WorkerError('artifact_checksum_mismatch');
      await chmod(target, file.path === 'artifacts/job-quota-query' ? 0o700 : 0o600);
      const handle = await open(target, 'r'); try { await handle.sync(); } finally { await handle.close(); }
    }
    const mf = await open(join(stage, 'manifest.json'), 'wx', 0o600); try { await mf.writeFile(bytes); await mf.sync(); } finally { await mf.close(); }
    const release = `${manifest.version}-${approvedManifestSha256}`;
    await syncArtifactDirectories(stage, manifest.files);
    try { await rename(stage, join(releases, release)); }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
      await verifyRelease(join(releases, release), approvedManifestSha256);
    }
    await syncDirectory(releases);
    if (!bound) await bindInstallationState(root, state);
    if (!stageOnly) {
      if (current) await switchLink(root, 'previous', current);
      await switchLink(root, 'current', `versions/${release}`);
    }
    return { version: manifest.version, manifestSha256: approvedManifestSha256,
      directory: join(releases, release) };
  } finally { await rm(stage, { recursive: true, force: true }); }
}

export async function readRetainedRelease(root) {
  const previous = await readlink(join(root, 'previous'));
  if (!/^versions\/\d+\.\d+\.\d+-[a-f0-9]{64}$/.test(previous)) throw new WorkerError('rollback_invalid');
  const manifest = await verifyRelease(join(root, previous), previous.slice(-64));
  return { manifest, directory: join(root, previous) };
}

export async function rollbackVersion({ root, stateDirectory, approveStop, facts, expected }) {
  return withInstallLock(root, async () => {
    const state = await requireInstallationState({ root, stateDirectory });
    const unlock = await acquireWorkerLock(state);
    try {
      if (!approveStop || await approveStop() !== true) throw new WorkerError('update_not_approved');
      const retained = await readRetainedRelease(root);
      validateManifest(retained.manifest, facts, expected);
      const previous = await readlink(join(root, 'previous'));
      await switchLink(root, 'current', previous);
    } finally {
      await unlock();
    }
  });
}
