import { readFile, lstat } from 'node:fs/promises';
import { accessSync, constants } from 'node:fs';
import { join, resolve } from 'node:path';

export class WorkerError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export function persistentFilesystems(mountInfo, home) {
  const mounts = mountInfo.trim().split('\n').flatMap((line) => {
    const [fields, tail] = line.split(' - ');
    if (!tail) return [];
    return [{ path: fields.split(' ')[4].replace(/\\040/g, ' '), type: tail.split(' ')[0] }];
  });
  const selected = (path) => mounts.filter((m) => path === m.path || path.startsWith(`${m.path === '/' ? '' : m.path}/`)).sort((a, b) => b.path.length - a.path.length)[0];
  const ephemeral = new Set(['overlay', 'aufs', 'tmpfs', 'ramfs', 'squashfs']);
  return { rootPersistent: !!selected('/') && !ephemeral.has(selected('/').type), homePersistent: !!selected(home) && !ephemeral.has(selected(home).type) };
}

export async function hostFacts(home) {
  const os = await readFile('/etc/os-release', 'utf8');
  const values = Object.fromEntries(os.split('\n').filter((line) => /^[A-Z_]+=/.test(line)).map((line) => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1).replace(/^"|"$/g, '')]; }));
  const libc = process.report.getReport().header.glibcVersionRuntime;
  return { os: values.ID, osRelease: values.VERSION_ID, arch: process.arch, libc: libc ? `glibc-${libc}` : 'unknown', node: process.version, ...persistentFilesystems(await readFile('/proc/self/mountinfo', 'utf8'), resolve(home)) };
}

export async function requirePrivateDirectory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new WorkerError('private_directory_required');
}

export function executableAvailability(path) {
  return Object.fromEntries(['node', 'git', 'codex', 'opencode', 'systemctl'].map((name) => [name, path.split(':').filter((p) => p.startsWith('/')).some((p) => { try { accessSync(join(p, name), constants.X_OK); return true; } catch { return false; } })]));
}

// Explicit projection: errors, credentials, process arguments and arbitrary metadata never cross this boundary.
export function doctorReport({ facts, identity, connection, service, executables, errors = [] }) {
  return {
    versions: { os: facts.os, osRelease: facts.osRelease, arch: facts.arch, libc: facts.libc, node: facts.node },
    persistentRoot: facts.rootPersistent, persistentHome: facts.homePersistent,
    executables: Object.fromEntries(['node', 'git', 'codex', 'opencode', 'systemctl'].map((key) => [key, executables[key] === true])),
    service: { active: service.active === true, userManagerAvailable: service.userManagerAvailable === true },
    identity: { installationId: identity?.workerInstallationId ?? null, selectedMainId: identity?.mainId ?? null, selectedMainFingerprint: identity?.mainPublicKeyFingerprint ?? null },
    pairing: identity?.deviceId ? 'paired' : 'unpaired',
    connection: ['connected', 'connecting', 'backoff', 'blocked', 'offline', 'stopped'].includes(connection?.state) ? connection.state : 'offline',
    errors: errors.filter((code) => SAFE_ERRORS.has(code)),
  };
}

const SAFE_ERRORS = new Set(['nonpersistent_root', 'nonpersistent_home', 'private_directory_required', 'identity_invalid', 'identity_read_only', 'systemd_user_manager_missing', 'connection_unavailable', 'service_not_running']);
