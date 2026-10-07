import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const COMMIT = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;

/** Prepares this build computer for one commit's dependencies, with no human step:
 * a checkout of the commit, an offline package seed fetched with network, the verification
 * image built without network, and the qualification source tree. Returns the facts Main
 * needs to capture and qualify the new runtime. Everything stays inside `installer`. */
export async function prepareCiRuntime({ repository, commit, installer, review, environment = process.env, log = () => {} }) {
  if (!COMMIT.test(commit)) throw new Error('A full commit id is required.');
  if (!review?.reviewedByPrincipalId || !/^[a-f0-9]{64}$/u.test(review.decisionDigest ?? '')) throw new Error('Owner decision is required.');
  const short = commit.slice(0, 12);
  const env = { ...environment, GIT_TERMINAL_PROMPT: '0' };
  const sh = async (file, args, options = {}) => {
    const result = await run(file, args, { env, maxBuffer: 64 * 1024 * 1024, ...options });
    return result.stdout;
  };
  const source = join(installer, `source-${short}`);
  if (!await exists(source)) {
    log('checkout');
    if ((await run('git', ['-C', repository, 'cat-file', '-e', `${commit}^{commit}`], { env }).then(() => true, () => false)) === false) {
      await sh('git', ['-C', repository, 'fetch', '--no-tags', 'origin', commit]);
    }
    await sh('git', ['-C', repository, 'worktree', 'add', '--detach', source, commit]);
  }
  const head = (await sh('git', ['-C', source, 'rev-parse', 'HEAD'])).trim();
  if (head !== commit) throw new Error('The prepared checkout is not at the requested commit.');

  // 1. The build stage fetches the frozen lockfile's packages with network into its own store.
  const buildContext = join(installer, `build-context-${short}`);
  await rm(buildContext, { recursive: true, force: true });
  await sh(process.execPath, [join(source, 'scripts/build-ci-runtime-context.mjs'), buildContext], { cwd: source });
  const buildTag = `localhost/foreman-code-ci-build:${short}`;
  log('fetch-packages');
  await podman(['build', '--pull=missing', '--target', 'build', '--layers=true', '--force-rm', '-t', buildTag, buildContext], env);
  const seedRoot = join(installer, `seed-${short}`);
  const seed = join(seedRoot, 'seed');
  await rm(seedRoot, { recursive: true, force: true });
  await mkdir(seed, { recursive: true, mode: 0o700 });
  const container = (await podmanOut(['create', buildTag, 'true'], env)).trim();
  try {
    for (const name of ['pnpm-store', 'corepack-cache']) {
      await podman(['cp', `${container}:/opt/graphql-ci/${name}`, join(seed, name)], env);
    }
  } finally { await podman(['rm', '-f', container], env).catch(() => {}); }

  // 2. Registry release evidence for the strict 48-hour policy, and the Codex binary the unit suite needs.
  log('seed-receipt');
  const unitCodex = await codexBinary(source, seed, env);
  const receipt = await createSeedReceipt({ repository: source, seed, review });
  const receiptPath = join(seedRoot, 'seed-receipt.json');
  await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
  const offlineSeedPath = join(seedRoot, 'offline-seed.json');
  await writeFile(offlineSeedPath, JSON.stringify({ directory: seed, receiptPath,
    unitCodex: { path: unitCodex.path, binarySha256: unitCodex.sha256, version: unitCodex.version, review } }), { mode: 0o600 });

  // 3. The verification image runs Jobs without network.
  const context = join(installer, `context-${short}`);
  await rm(context, { recursive: true, force: true });
  await sh(process.execPath, [join(source, 'scripts/build-ci-runtime-context.mjs'), context, offlineSeedPath], { cwd: source });
  const tag = `localhost/foreman-code-verification:${short}`;
  log('build-image');
  await podman(['build', '--pull=never', '--network=none', '--target', 'verification', '--layers=false', '--force-rm',
    '--label', 'io.foreman-code.installation=ci-verification', '-t', tag, context], env);
  const image = JSON.parse(await podmanOut(['image', 'inspect', tag], env))[0];

  // 4. The exact tracked tree Main approved for this commit, which qualification verifies byte for byte.
  const qualificationSource = join(installer, `qualification-source-${short}`);
  if (!await exists(qualificationSource)) {
    await mkdir(qualificationSource, { mode: 0o700 });
    const archive = spawn('git', ['-C', repository, 'archive', '--format=tar', commit], { env });
    const extract = spawn('/bin/sh', ['-c', 'umask 077 && exec tar -x -C "$1"', 'sh', qualificationSource], { env });
    archive.stdout.pipe(extract.stdin);
    await Promise.all([closed(archive, 'git archive'), closed(extract, 'tar')]);
  }
  return { commit, imageId: `sha256:${image.Id.replace(/^sha256:/u, '')}`, imageManifestDigest: image.Digest,
    seedReceiptPath: join(context, 'seed-receipt.json'), contextReceiptPath: join(context, 'context-receipt.json'),
    qualificationSource, unitCodex: { executable: '/opt/graphql-ci/tools/codex', sourceExecutable: unitCodex.path,
      version: unitCodex.version, binarySha256: unitCodex.sha256 } };
}

async function codexBinary(source, seed, env) {
  // The unit suite builds the Worker artifact with the exact locked Codex release.
  const corepack = { ...env, COREPACK_HOME: join(seed, 'corepack-cache'), COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' };
  await run('corepack', ['pnpm', 'install', '--frozen-lockfile', '--offline', '--ignore-scripts', '--store-dir', join(seed, 'pnpm-store')],
    { cwd: source, env: corepack, maxBuffer: 64 * 1024 * 1024 });
  const apiRequire = createRequire(join(source, 'apps/api/package.json'));
  const launcher = apiRequire.resolve('@openai/codex/bin/codex.js');
  const native = createRequire(launcher).resolve('@openai/codex-linux-x64/package.json');
  const path = await realpath(join(dirname(native), 'vendor/x86_64-unknown-linux-musl/bin/codex'));
  const version = (await run(path, ['--version'], { env })).stdout.trim();
  return { path, version, sha256: hash(await readFile(path)) };
}

/** Same receipt the CI image policy verifies: every locked release with its registry publish time. */
export async function createSeedReceipt({ repository, seed, review }) {
  const require = createRequire(join(repository, 'apps/worker/package.json'));
  const { parse } = require('yaml');
  const lock = parse(await readFile(join(repository, 'pnpm-lock.yaml'), 'utf8'));
  const packages = Object.entries(lock.packages ?? {}).map(([key, value]) => {
    const at = key.lastIndexOf('@');
    return { name: key.slice(0, at), version: key.slice(at + 1), integrity: value.resolution.integrity };
  });
  const names = [...new Set(packages.map(value => value.name))];
  const captured = new Map();
  await mkdir(join(seed, 'metadata'), { recursive: true, mode: 0o700 });
  let cursor = 0;
  const capture = async () => {
    while (cursor < names.length) {
      const name = names[cursor++];
      const metadataPath = `metadata/${encodeURIComponent(name)}.json`;
      const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`Registry returned ${response.status} for ${name}`);
      const metadata = await response.json();
      const selected = { name, time: {}, versions: {} };
      for (const pkg of packages.filter(value => value.name === name)) {
        const entry = metadata.versions?.[pkg.version];
        if (!entry || entry.dist?.integrity !== pkg.integrity || !metadata.time?.[pkg.version]) {
          throw new Error(`Registry release differs from the frozen lockfile: ${name}@${pkg.version}`);
        }
        selected.time[pkg.version] = metadata.time[pkg.version];
        selected.versions[pkg.version] = entry;
      }
      await writeFile(join(seed, metadataPath), JSON.stringify(selected), { mode: 0o600 });
      for (const kind of ['metadata', 'metadata-full']) {
        const destination = join(seed, 'registry-cache/v11', kind, 'https%3A+registry.npmjs.org', `${name}.jsonl`);
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        await writeFile(destination, `${JSON.stringify({ etag: response.headers.get('etag'), modified: metadata.modified })}\n${JSON.stringify(metadata)}\n`, { mode: 0o600 });
      }
      captured.set(name, { metadataPath, metadata: selected });
    }
  };
  await Promise.all(Array.from({ length: 4 }, capture));
  const tracked = (await run('git', ['-C', repository, 'ls-tree', '-r', '--name-only', 'HEAD'], { maxBuffer: 64 * 1024 * 1024 })).stdout;
  const inputPaths = tracked.trim().split('\n').filter(path => ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].includes(path)
    || /^(?:apps|packages)\/[^/]+\/package\.json$/u.test(path)).sort();
  const dependencyInputs = await Promise.all(inputPaths.map(async path => ({ path, sha256: hash(await readFile(join(repository, path))) })));
  const files = [];
  const walk = async (directory, prefix = '') => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(directory, entry.name), path);
      else {
        const file = join(directory, entry.name);
        const info = await lstat(file);
        if (!info.isFile() || info.nlink !== 1) throw new Error(`Nonregular seed entry: ${path}`);
        const bytes = await readFile(file);
        files.push({ path, bytes: bytes.length, sha256: hash(bytes) });
      }
    }
  };
  await walk(seed);
  files.sort((a, b) => a.path.localeCompare(b.path));
  const capturedAt = new Date().toISOString();
  const releases = packages.map(pkg => ({ ...pkg, publishedAt: captured.get(pkg.name).metadata.time[pkg.version],
    metadataPath: captured.get(pkg.name).metadataPath }));
  return { schemaVersion: 1, packageManager: 'pnpm@11.27.0', platform: { os: 'linux', arch: 'x64', libc: 'glibc' },
    minimumReleaseAge: 2880, minimumReleaseAgeStrict: true, minimumReleaseAgeIgnoreMissingTime: false, capturedAt,
    provenanceDigest: hash(JSON.stringify({ dependencyInputs, releases, inventory: files })),
    review: { ...review, reviewedAt: capturedAt }, maxBytes: 20 * 2 ** 30, maxInodes: 1_000_000, dependencyInputs, files, packages: releases };
}

const podman = (args, env) => run('podman', ['--remote=false', ...args], { env, maxBuffer: 256 * 1024 * 1024 });
const podmanOut = async (args, env) => (await podman(args, env)).stdout;
const exists = path => stat(path).then(() => true, () => false);
const closed = (child, name) => new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('close', code => code === 0 ? resolve() : reject(new Error(`${name} exited ${code}`)));
});
