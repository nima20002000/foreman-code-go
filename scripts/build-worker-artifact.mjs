import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, copyFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire, isBuiltin } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'apps/worker/package.json'));
const { build } = require('esbuild');
const [targetFile, outputDirectory, runtimeFile] = process.argv.slice(2);
if (!targetFile || !outputDirectory) throw new Error('Usage: build-worker-artifact.mjs /approved-target.json /new-output-directory [/reviewed-runtime.json]');
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
async function requirePinnedSource(path) {
  const pinned = execFileSync('git', ['show', `${commit}:${path}`], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  if (!pinned.equals(await readFile(join(root, path)))) throw new Error(`Uncommitted artifact source: ${path}`);
}
for (const path of ['scripts/build-worker-artifact.mjs', 'apps/worker/package.json', 'pnpm-lock.yaml']) await requirePinnedSource(path);
const target = JSON.parse(await readFile(targetFile, 'utf8'));
if (target.os !== 'ubuntu' || !/^\d+\.\d+$/.test(target.osRelease) || !['x64', 'arm64'].includes(target.arch) || !/^glibc-\d+\.\d+$/.test(target.libc) || !/^v22\.\d+\.\d+$/.test(target.node)) throw new Error('Unsupported build target');
const runtime = runtimeFile ? JSON.parse(await readFile(runtimeFile, 'utf8')) : null;
if (runtime && (runtime.format !== 1 || runtime.runtime !== 'node' || runtime.platform !== 'linux' || runtime.arch !== target.arch || runtime.version !== target.node
  || !/^[a-f0-9]{64}$/.test(runtime.archive?.sha256) || !/^[a-f0-9]{64}$/.test(runtime.nodeExecutable?.sha256)
  || !/^[A-F0-9]{40}$/.test(runtime.trustedRelease?.primarySignerFingerprint))) throw new Error('Reviewed runtime does not match target');
// Fresh directories only: never mix files from another release or ship credentials.
const output = resolve(outputDirectory); await mkdir(output, { mode: 0o700 }); await mkdir(join(output, 'src'));
const built = await build({ absWorkingDir: root, entryPoints: { cli: 'apps/worker/src/cli.mjs', worker: 'apps/worker/src/workerFactory.mjs' }, outdir: join(output, 'src'), outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', format: 'esm', target: 'node22', metafile: true, sourcemap: false, packages: 'bundle',
  alias: { '@graphql/contracts/device-identity-node': './packages/contracts/src/deviceIdentityNode.ts', '@graphql/contracts/device-identity': './packages/contracts/src/deviceIdentity.ts', '@graphql/contracts/device-connection': './packages/contracts/src/deviceConnection.ts', '@graphql/contracts/device-application': './packages/contracts/src/deviceApplication.ts', '@graphql/contracts/workspace-root-policies': './packages/contracts/src/workspaceRootPolicies.ts', '@graphql/contracts/source-materialization': './packages/contracts/src/sourceMaterialization.ts' },
  define: { 'process.env.WS_NO_BUFFER_UTIL': '"1"', 'process.env.WS_NO_UTF_8_VALIDATE': '"1"' },
  banner: { js: "import { createRequire as workerCreateRequire } from 'node:module'; const require = workerCreateRequire(import.meta.url);" } });
const allowedApiModules = new Set(['connectionSupervisor.ts', 'deviceWire.ts', 'deviceCarrier.ts', 'workerConnection.ts', 'deviceApplicationChannel.ts'].map((name) => `apps/api/src/modules/devices/${name}`));
for (const name of ['rootAttestation.ts', 'privateFilesystem.ts', 'manifest.ts']) allowedApiModules.add(`apps/api/src/modules/sources/${name}`);
for (const source of Object.keys(built.metafile.inputs)) {
  if (!source.startsWith('node_modules/') && !source.includes('/node_modules/')) await requirePinnedSource(source);
  if (source.startsWith('apps/api/') && !allowedApiModules.has(source)) throw new Error(`Forbidden control-plane import: ${source}`);
}
for (const entry of Object.values(built.metafile.outputs)) for (const dependency of entry.imports) {
  if (dependency.external && !isBuiltin(dependency.path)) throw new Error(`Unbundled dependency: ${dependency.path}`);
}
for (const name of ['installation.mjs', 'diagnostics.mjs', 'service.mjs', 'install-cli.mjs', 'runtime.mjs']) {
  await requirePinnedSource(`apps/worker/src/${name}`);
  await copyFile(join(root, 'apps/worker/src', name), join(output, 'src', name));
}
await mkdir(join(output, 'artifacts'));
await requirePinnedSource('apps/worker/artifacts/graphql-worker.service.in');
await copyFile(join(root, 'apps/worker/artifacts/graphql-worker.service.in'), join(output, 'artifacts/graphql-worker.service.in'));
if (runtime) await copyFile(runtimeFile, join(output, 'artifacts/node-runtime.json'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const files = [];
async function walk(directory, prefix = '') {
  for (const name of (await readdir(directory)).sort()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (name === 'src' || name === 'artifacts') { await walk(join(directory, name), path); continue; }
    const bytes = await readFile(join(directory, name)); files.push({ path, sha256: hash(bytes), size: bytes.length });
  }
}
await walk(output);
const pkg = JSON.parse(await readFile(join(root, 'apps/worker/package.json'), 'utf8'));
const manifest = { format: 1, version: pkg.version, commit, lockfileSha256: hash(await readFile(join(root, 'pnpm-lock.yaml'))), packageManager: 'pnpm@11.27.0', protocolVersion: 1, identityFormat: 1, target,
  ...(runtime ? { runtime: { metadataPath: 'artifacts/node-runtime.json', version: runtime.version, archiveSha256: runtime.archive.sha256, executableSha256: runtime.nodeExecutable.sha256, qualification: 'future installation requires actual target readback' } } : {}), files };
await writeFile(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ manifestSha256: hash(await readFile(join(output, 'manifest.json'))), version: pkg.version, commit: manifest.commit, files: files.length }));
