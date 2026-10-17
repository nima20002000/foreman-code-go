import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { WorkerError } from './diagnostics.mjs';

/** Called under the installation lock; keep the launcher's approved Node and environment. */
export async function migratePinnedCompanionLauncher(root) {
  const launcher = join(root, 'graphql-companion');
  let info;
  try { info = await lstat(launcher); }
  catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077)) {
    throw new WorkerError('companion_launcher_invalid');
  }
  const script = await readFile(launcher, 'utf8');
  const pinned = /'([^'\n]+)\/versions\/\d+\.\d+\.\d+-[a-f0-9]{64}\/src\/companion\.mjs'/g;
  const migrated = script.replace(pinned, (entry, installedRoot) =>
    installedRoot === root ? `'${join(root, 'current/src/companion.mjs')}'` : entry);
  if (migrated === script) return;
  const temporary = `${launcher}.${randomUUID()}`;
  try {
    const file = await open(temporary, 'wx', 0o700);
    try {
      await file.writeFile(migrated);
      await file.sync();
    } finally { await file.close(); }
    await rename(temporary, launcher);
    const directory = await open(root, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temporary, { force: true }); }
}
