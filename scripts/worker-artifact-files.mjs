import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, mkdir, writeFile, realpath } from 'node:fs/promises';
import { join, dirname, resolve, relative } from 'node:path';

export function committedWorkerInputPath(root, input) {
  const path = relative(root, resolve(root, input));
  if (!path.startsWith('apps/worker/artifacts/') || !safePath(path) || !path.endsWith('.json')) {
    throw new Error('Reviewed target/runtime JSON must be a committed repository file under apps/worker/artifacts/');
  }
  return path;
}

export function workerReleaseVersion(product) {
  if (!/^\d+\.\d+\.\d+$/.test(product.version)) throw new Error('Product release version is invalid');
  return product.version;
}

export function validateWorkerTarget(target) {
  if (target.arch !== 'x64') throw new Error('Sharp assets are qualified only for linux-x64');
  if (target.os !== 'ubuntu' || !/^\d+\.\d+$/.test(target.osRelease)
    || !/^glibc-\d+\.\d+$/.test(target.libc) || !/^v22\.\d+\.\d+$/.test(target.node)) {
    throw new Error('Unsupported build target');
  }
}

export const sharpPackages = Object.freeze({
  sharp: '0.35.4', '@img/colour': '1.1.0', 'detect-libc': '2.1.2', semver: '7.8.5',
  '@img/sharp-linux-x64': '0.35.4', '@img/sharp-libvips-linux-x64': '1.3.3',
});
export function assertWorkerDependency(path) {
  if (/^(?:pg(?:-|$|\/)|postgres(?:$|\/)|@fastify\/|fastify(?:$|\/)|drizzle-orm(?:$|\/)|kysely(?:$|\/))/.test(path)) {
    throw new Error(`Forbidden control-plane dependency: ${path}`);
  }
}
const digest = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');
export function safePath(path) {
  return typeof path === 'string' && /^[a-zA-Z0-9_@./-]+$/.test(path)
    && path.split('/').every(part => part && part !== '.' && part !== '..');
}

// Package roots are pnpm links; every entry beneath the resolved root must be regular.
export async function regularFiles(directory, { excludeNodeModules = false } = {}) {
  const files = new Map();
  async function walk(path, prefix = '') {
    if (!(await lstat(path)).isDirectory()) throw new Error(`Nonregular directory: ${path}`);
    for (const name of (await readdir(path)).sort()) {
      if (excludeNodeModules && name === 'node_modules') continue;
      const relative = prefix ? `${prefix}/${name}` : name;
      if (!safePath(relative)) throw new Error(`Unsafe file path: ${relative}`);
      const source = join(path, name), info = await lstat(source);
      if (info.isDirectory()) await walk(source, relative);
      else if (info.isFile()) files.set(relative, await readFile(source));
      else throw new Error(`Nonregular package file: ${relative}`);
    }
  }
  await walk(directory);
  return files;
}

export function verifyPackage(name, version, index, files) {
  if (!index || index.requiresBuild !== false || index.manifest?.name !== name || index.manifest?.version !== version
    || index.algo !== 'sha512' || !(index.files instanceof Map)) throw new Error(`Invalid package index: ${name}@${version}`);
  const expected = new Map([...index.files].filter(([path]) => !path.split('/').includes('node_modules')));
  if (expected.size !== files.size) throw new Error(`Package file set mismatch: ${name}`);
  for (const [path, entry] of expected) {
    const bytes = files.get(path);
    if (!safePath(path) || !bytes || !/^[a-f0-9]{128}$/.test(entry.digest) || entry.size !== bytes.length
      || digest('sha512', bytes) !== entry.digest) throw new Error(`Package integrity mismatch: ${name}/${path}`);
  }
  const manifest = JSON.parse(files.get('package.json'));
  if (manifest.name !== name || manifest.version !== version) throw new Error(`Package identity mismatch: ${name}`);
  // The locked libvips tarball publishes its dependency license table in README.md.
  const licenseTable = name === '@img/sharp-libvips-linux-x64' && manifest.license === 'LGPL-3.0-or-later'
    && files.get('README.md')?.toString('utf8').includes('LGPLv3');
  if (!licenseTable && ![...files.keys()].some(path => /(?:^|\/)(?:LICENSE|LICENCE|COPYING)(?:\.|$)/i.test(path))) throw new Error(`Package license missing: ${name}`);
}

export async function copySharpPackages({ root, output, lock, record, decode }) {
  const modules = join(root, 'node_modules/.pnpm'), installed = await readdir(modules), packages = [];
  for (const [name, version] of Object.entries(sharpPackages)) {
    const integrity = lock.packages?.[`${name}@${version}`]?.resolution?.integrity;
    if (typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)) throw new Error(`Missing locked integrity: ${name}`);
    const prefix = `${name.replace('/', '+')}@${version}`;
    const candidates = installed.filter(path => path === prefix || path.startsWith(`${prefix}_`));
    if (candidates.length !== 1) throw new Error(`Ambiguous installed package: ${name}`);
    const source = await realpath(join(modules, candidates[0], 'node_modules', name));
    const files = await regularFiles(source, { excludeNodeModules: true });
    const blob = record(`${integrity}\t${name}@${version}`);
    if (!(blob instanceof Uint8Array)) throw new Error(`Invalid package index blob: ${name}@${version}`);
    verifyPackage(name, version, decode(blob), files);
    for (const [path, bytes] of files) {
      const destination = join(output, 'node_modules', name, path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      // Write the buffers that passed validation, never reread a mutable source.
      await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
    }
    packages.push({ name, version, integrity, indexBlobSha256: digest('sha256', blob), files: files.size, bytes: [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0) });
  }
  return packages;
}

export async function artifactFiles(output) {
  return [...await regularFiles(output)].map(([path, bytes]) => ({ path, sha256: digest('sha256', bytes), size: bytes.length }));
}
