import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const controlRoot = 'apps/worker/artifacts/ci-runtime';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export async function buildCiRuntimeContext({ repository, commit = 'HEAD', output }) {
  const git = (...args) => execFileSync('git', args, { cwd: repository, stdio: ['ignore', 'pipe', 'pipe'] });
  const captured = git('rev-parse', `${commit}^{commit}`).toString().trim();
  const tree = git('ls-tree', '-rz', '--full-tree', captured).toString().split('\0').filter(Boolean).map(line => {
    const tab = line.indexOf('\t');
    const [mode, type, blob] = line.slice(0, tab).split(' '), path = line.slice(tab + 1);
    return { mode, type, blob, path };
  });
  const paths = tree.filter(entry => ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].includes(entry.path)
    || /^(?:apps|packages)\/[^/]+\/package\.json$/.test(entry.path));
  const controls = ['Containerfile', 'corepack'].map(name => ({ name, entry: tree.find(entry => entry.path === `${controlRoot}/${name}`) }));
  if (!paths.some(entry => entry.path === 'pnpm-lock.yaml') || !paths.some(entry => entry.path === 'pnpm-workspace.yaml')) throw new Error('Committed CI lockfile and workspace policy required');
  const entries = [...paths, ...controls.map(control => control.entry)];
  if (entries.some(entry => !entry || entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)
    || entry.path.split('/').some(part => !part || part === '.' || part === '..'))) throw new Error('CI context requires regular committed inputs');
  const snapshots = new Map(entries.map(entry => [entry.path, { ...entry, bytes: git('show', `${captured}:${entry.path}`) }]));
  await mkdir(output, { mode: 0o700 });
  for (const entry of paths) {
    const destination = join(output, 'source-lock', entry.path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, snapshots.get(entry.path).bytes, { mode: 0o600, flag: 'wx' });
  }
  for (const { name, entry } of controls) await writeFile(join(output, name), snapshots.get(entry.path).bytes, { mode: name === 'corepack' ? 0o700 : 0o600, flag: 'wx' });
  const receipt = { sourceCommit: captured, files: [...snapshots.values()].map(({ path, blob, bytes }) => ({ path, gitBlobSha1: blob, sha256: hash(bytes) })).sort((a, b) => a.path.localeCompare(b.path)) };
  await writeFile(join(output, 'context-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Usage: build-ci-runtime-context.mjs /new/private/context');
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const receipt = await buildCiRuntimeContext({ repository, output: resolve(process.argv[2]) });
  console.log(JSON.stringify({ sourceCommit: receipt.sourceCommit, files: receipt.files.length }));
}
