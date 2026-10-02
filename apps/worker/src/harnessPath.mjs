import { accessSync, constants, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

// Discover installed user tools without sourcing profiles or inheriting a caller's
// PATH. NVM's npm launchers are symlinks into the same user-owned installation.
export function workerPath(home, node) {
  const directories = [dirname(node), '/usr/bin', '/bin'];
  const uid = process.getuid();
  function owned(path, directory) {
    const info = lstatSync(path);
    return info.uid === uid && !(info.mode & 0o002) && (directory ? info.isDirectory() : info.isFile());
  }
  function trusted(path, directory = true) {
    if (!path.startsWith(`${home}/`)) return false;
    const parts = relative(home, path).split('/');
    let current = home;
    if (!owned(current, true)) return false;
    for (let i = 0; i < parts.length; i++) {
      current = join(current, parts[i]);
      if (!owned(current, i < parts.length - 1 || directory)) return false;
    }
    return true;
  }
  function add(directory) {
    try {
      if (!trusted(directory)) return;
      const installed = ['codex', 'opencode'].some((name) => {
        try {
          const launcher = realpathSync(join(directory, name));
          if (!trusted(launcher, false)) return false;
          accessSync(launcher, constants.X_OK);
          return true;
        } catch { return false; }
      });
      if (installed) directories.push(directory);
    } catch { /* Missing or untrusted installations do not extend PATH. */ }
  }
  if (typeof home === 'string' && home.startsWith('/') && resolve(home) === home && /^[/a-zA-Z0-9_.-]+$/.test(home)) {
    add(join(home, '.local/bin'));
    add(join(home, '.opencode/bin'));
    const versions = join(home, '.nvm/versions/node');
    try {
      if (trusted(versions)) {
        for (const entry of readdirSync(versions, { withFileTypes: true }).filter((entry) => entry.isDirectory() && /^v\d+\.\d+\.\d+$/.test(entry.name)).sort((a, b) => b.name.localeCompare(a.name, 'en', { numeric: true }))) add(join(versions, entry.name, 'bin'));
      }
    } catch { /* NVM is optional. */ }
  }
  return [...new Set(directories)].join(':');
}
