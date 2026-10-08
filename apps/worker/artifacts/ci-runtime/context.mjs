import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { constants } from 'node:fs';
import { parse } from 'yaml';
import { readSeedFile, readSeedFileEntry, validateSeedReceipt, verifySeedFiles } from './seed-policy.mjs';

export const parseCiLock = text => parse(text);

const controlRoot = 'apps/worker/artifacts/ci-runtime';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export async function buildCiRuntimeContext({ repository, commit = 'HEAD', output, offlineSeed }) {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const git = (...args) => execFileSync('git', args, { cwd: repository, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  const captured = git('rev-parse', `${commit}^{commit}`).toString().trim();
  const tree = git('ls-tree', '-rz', '--full-tree', captured).toString().split('\0').filter(Boolean).map(line => {
    const tab = line.indexOf('\t');
    const [mode, type, blob] = line.slice(0, tab).split(' '), path = line.slice(tab + 1);
    return { mode, type, blob, path };
  });
  const paths = tree.filter(entry => ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].includes(entry.path)
    || /^(?:apps|packages)\/[^/]+\/package\.json$/.test(entry.path));
  const controlNames = ['Containerfile', 'corepack'];
  if (offlineSeed) controlNames.push('seed-policy.mjs', 'verification-policy.mjs', 'verification-observation.mjs');
  const controls = controlNames.map(name => ({ name, entry: tree.find(entry => entry.path === `${controlRoot}/${name}`) }));
  if (!paths.some(entry => entry.path === 'pnpm-lock.yaml') || !paths.some(entry => entry.path === 'pnpm-workspace.yaml')) throw new Error('Committed CI lockfile and workspace policy required');
  const entries = [...paths, ...controls.map(control => control.entry)];
  if (entries.some(entry => !entry || entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)
    || entry.path.split('/').some(part => !part || part === '.' || part === '..'))) throw new Error('CI context requires regular committed inputs');
  const snapshots = new Map(entries.map(entry => [entry.path, { ...entry, bytes: git('show', `${captured}:${entry.path}`) }]));
  let seed;
  let seedUsage;
  if (offlineSeed) {
    const receiptFile = await open(offlineSeed.receiptPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await receiptFile.stat();
      if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || info.mode & 0o077
        || info.size > 16 * 1024 * 1024) throw new Error('Private reviewed seed receipt required.');
      seed = JSON.parse((await readSeedFile(dirname(offlineSeed.receiptPath),
        offlineSeed.receiptPath.slice(dirname(offlineSeed.receiptPath).length + 1), info.size)).toString('utf8'));
    } finally { await receiptFile.close(); }
    const lock = parse(snapshots.get('pnpm-lock.yaml').bytes.toString('utf8'));
    const policy = parse(snapshots.get('pnpm-workspace.yaml').bytes.toString('utf8'));
    const manifest = JSON.parse(snapshots.get('package.json').bytes.toString('utf8'));
    if (manifest.packageManager !== 'pnpm@11.27.0' || policy.minimumReleaseAge !== 2880
      || policy.minimumReleaseAgeStrict !== true || policy.minimumReleaseAgeIgnoreMissingTime !== false
      || policy.minimumReleaseAgeExclude?.length) throw new Error('Committed strict 48-hour package policy required.');
    const packages = Object.entries(lock.packages ?? {}).map(([key, pkg]) => {
      const separator = key.lastIndexOf('@');
      if (separator < 1 || !pkg.resolution?.integrity) throw new Error('Locked registry package release evidence required.');
      return { name: key.slice(0, separator), version: key.slice(separator + 1), integrity: pkg.resolution.integrity };
    });
    const dependencyInputs = paths.map(entry => ({ path: entry.path, sha256: hash(snapshots.get(entry.path).bytes) }))
      .sort((a, b) => a.path.localeCompare(b.path));
    validateSeedReceipt(seed, { dependencyInputs, packages, platform: { os: 'linux', arch: 'x64', libc: 'glibc' } });
    seedUsage = await verifySeedFiles(offlineSeed.directory, seed);
  }
  let unitCodex;
  if (offlineSeed?.unitCodex) {
    const tool = offlineSeed.unitCodex;
    if (!tool.review?.reviewedByPrincipalId || !/^[a-f0-9]{64}$/.test(tool.review.decisionDigest)
      || !Number.isFinite(Date.parse(tool.review.reviewedAt)) || Date.parse(tool.review.reviewedAt) > Date.now()
      || !/^[a-f0-9]{64}$/.test(tool.binarySha256) || !tool.version || !tool.path?.startsWith('/')) {
      throw new Error('Reviewed Codex schema binary receipt required.');
    }
    const bytes = await readSeedFile(dirname(tool.path), tool.path.slice(dirname(tool.path).length + 1), 256 * 1024 * 1024);
    if (hash(bytes) !== tool.binarySha256) throw new Error('Reviewed Codex schema binary changed.');
    unitCodex = { tool, bytes };
  }
  await mkdir(output, { mode: 0o700 });
  await mkdir(join(output, 'tools'), { mode: 0o700 });
  if (unitCodex) await writeFile(join(output, 'tools/codex'), unitCodex.bytes, { mode: 0o700, flag: 'wx' });
  for (const entry of paths) {
    const destination = join(output, 'source-lock', entry.path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, snapshots.get(entry.path).bytes, { mode: 0o600, flag: 'wx' });
  }
  for (const { name, entry } of controls) await writeFile(join(output, name), snapshots.get(entry.path).bytes, { mode: name === 'corepack' ? 0o700 : 0o600, flag: 'wx' });
  const receipt = { sourceCommit: captured, files: [...snapshots.values()].map(({ path, blob, bytes }) => ({ path, gitBlobSha1: blob, sha256: hash(bytes) })).sort((a, b) => a.path.localeCompare(b.path)) };
  if (seed) {
    for (const file of seed.files) {
      const { bytes, executable } = await readSeedFileEntry(offlineSeed.directory, file.path, file.bytes);
      if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new Error('Reviewed offline seed changed during copy.');
      const destination = join(output, 'seed', file.path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, bytes, { mode: executable ? 0o700 : 0o600, flag: 'wx' });
    }
    const seedBytes = Buffer.from(`${JSON.stringify(seed)}\n`);
    await writeFile(join(output, 'seed-receipt.json'), seedBytes, { mode: 0o600, flag: 'wx' });
    receipt.offlineSeed = { receiptSha256: hash(seedBytes), ...seedUsage, platform: seed.platform,
      packageManager: seed.packageManager, provenanceDigest: seed.provenanceDigest,
      releaseAge: { minimumMinutes: 2880, strict: true, rejectMissingTime: true, packages: seed.packages.length } };
  }
  if (unitCodex) receipt.unitCodex = { version: unitCodex.tool.version, binarySha256: unitCodex.tool.binarySha256,
    executable: '/opt/graphql-ci/tools/codex', review: unitCodex.tool.review };
  await writeFile(join(output, 'context-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return receipt;
}

