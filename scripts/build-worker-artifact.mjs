import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire, isBuiltin } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'apps/worker/package.json'));
const { build } = require('esbuild');
const [targetFile, outputDirectory, runtimeFile] = process.argv.slice(2);
if (!targetFile || !outputDirectory) throw new Error('Usage: build-worker-artifact.mjs /approved-target.json /new-output-directory [/reviewed-runtime.json]');
const requestedCommit = process.env.GRAPHQL_WORKER_BUILD_COMMIT;
if (requestedCommit && !/^[a-f0-9]{40}$/.test(requestedCommit)) throw new Error('Invalid captured commit');
const commit = execFileSync('git', ['rev-parse', requestedCommit ? `${requestedCommit}^{commit}` : 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const allowedApiModules = new Set(['connectionSupervisor.ts', 'deviceWire.ts', 'deviceCarrier.ts', 'workerConnection.ts', 'deviceApplicationChannel.ts'].map((name) => `apps/api/src/modules/devices/${name}`));
for (const name of ['rootAttestation.ts', 'privateFilesystem.ts', 'manifest.ts']) allowedApiModules.add(`apps/api/src/modules/sources/${name}`);
for (const name of ['executionHost.ts', 'executionRouter.ts', 'jobExecutionHost.ts', 'runtimeLeaf.ts', 'workerComposition.ts']) allowedApiModules.add(`apps/api/src/modules/runs/remote/${name}`);
for (const name of ['executor.ts', 'inputs.ts', 'repository.ts']) allowedApiModules.add(`apps/api/src/modules/jobs/${name}`);
allowedApiModules.add('apps/api/src/modules/placement/binding.ts');
allowedApiModules.add('apps/api/src/modules/placement/executionBinding.ts');
allowedApiModules.add('apps/api/src/modules/errors.ts');
const snapshot = new Map();
function snapshotSource(path) {
  if (path.startsWith('/') || path.split('/').some((part) => !part || part === '.' || part === '..') || /\.(?:test|spec)\.[cm]?[jt]s$/.test(path) || /(?:^|\/)\.env(?:\.|$)|\.(?:pem|key)$|(?:^|\/)(?:credentials|secrets)\.json$/.test(path)
    || !(allowedApiModules.has(path) || path.startsWith('apps/worker/src/') || path.startsWith('apps/worker/artifacts/') || path.startsWith('packages/contracts/src/')
      || ['scripts/build-worker-artifact.mjs', 'apps/worker/package.json', 'pnpm-lock.yaml'].includes(path))) throw new Error(`Forbidden snapshot source: ${path}`);
  if (!snapshot.has(path)) {
    const bytes = execFileSync('git', ['show', `${commit}:${path}`], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    const gitBlobSha1 = execFileSync('git', ['rev-parse', `${commit}:${path}`], { cwd: root, encoding: 'utf8' }).trim();
    snapshot.set(path, { bytes, gitBlobSha1, sha256: hash(bytes) });
  }
  return snapshot.get(path).bytes;
}
async function requirePinnedSource(path) {
  if (!snapshotSource(path).equals(await readFile(join(root, path)))) throw new Error(`Uncommitted build control input: ${path}`);
}
for (const path of ['scripts/build-worker-artifact.mjs', 'apps/worker/package.json', 'pnpm-lock.yaml']) await requirePinnedSource(path);
const target = JSON.parse(snapshotSource(relative(root, resolve(targetFile))).toString('utf8'));
if (target.os !== 'ubuntu' || !/^\d+\.\d+$/.test(target.osRelease) || !['x64', 'arm64'].includes(target.arch) || !/^glibc-\d+\.\d+$/.test(target.libc) || !/^v22\.\d+\.\d+$/.test(target.node)) throw new Error('Unsupported build target');
const runtime = runtimeFile ? JSON.parse(snapshotSource(relative(root, resolve(runtimeFile))).toString('utf8')) : null;
if (runtime && (runtime.format !== 1 || runtime.runtime !== 'node' || runtime.platform !== 'linux' || runtime.arch !== target.arch || runtime.version !== target.node
  || !/^[a-f0-9]{64}$/.test(runtime.archive?.sha256) || !/^[a-f0-9]{64}$/.test(runtime.nodeExecutable?.sha256)
  || !/^[A-F0-9]{40}$/.test(runtime.trustedRelease?.primarySignerFingerprint))) throw new Error('Reviewed runtime does not match target');
// Fresh directories only: never mix files from another release or ship credentials.
const output = resolve(outputDirectory); await mkdir(output, { mode: 0o700 }); await mkdir(join(output, 'src'));
const built = await build({ absWorkingDir: root, entryPoints: { cli: 'apps/worker/src/cli.mjs', worker: 'apps/worker/src/workerFactory.mjs' }, outdir: join(output, 'src'), outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', format: 'esm', target: 'node22', metafile: true, sourcemap: false, packages: 'bundle',
  alias: { '@graphql/contracts': './packages/contracts/src/index.ts', '@graphql/contracts/wave25': './packages/contracts/src/wave25/index.ts', '@graphql/contracts/jobs': './packages/contracts/src/jobs.ts', '@graphql/contracts/jobs-node': './packages/contracts/src/jobsNode.ts', '@graphql/contracts/job-inputs': './packages/contracts/src/jobInputs.ts', '@graphql/contracts/job-inputs-node': './packages/contracts/src/jobInputsNode.ts', '@graphql/contracts/node-placement': './packages/contracts/src/nodePlacement.ts', '@graphql/contracts/remote-execution': './packages/contracts/src/remoteExecution.ts', '@graphql/contracts/remote-execution-rpc': './packages/contracts/src/remoteExecutionRpc.ts', '@graphql/contracts/remote-job-execution': './packages/contracts/src/remoteJobExecution.ts', '@graphql/contracts/command-identity-node': './packages/contracts/src/commandIdentityNode.ts', '@graphql/contracts/device-tls-node': './packages/contracts/src/deviceTlsNode.ts', '@graphql/contracts/device-setup': './packages/contracts/src/deviceSetup.ts', '@graphql/contracts/device-setup-node': './packages/contracts/src/deviceSetupNode.ts', '@graphql/contracts/device-identity-node': './packages/contracts/src/deviceIdentityNode.ts', '@graphql/contracts/device-identity': './packages/contracts/src/deviceIdentity.ts', '@graphql/contracts/device-connection': './packages/contracts/src/deviceConnection.ts', '@graphql/contracts/device-application': './packages/contracts/src/deviceApplication.ts', '@graphql/contracts/workspace-root-policies': './packages/contracts/src/workspaceRootPolicies.ts', '@graphql/contracts/source-materialization': './packages/contracts/src/sourceMaterialization.ts' },
  plugins: [{ name: 'committed-source-snapshot', setup(builder) {
    builder.onLoad({ filter: /\.(?:[cm]?[jt]s|json)$/ }, (input) => {
      const path = relative(root, input.path);
      if (path.startsWith('node_modules/') || path.includes('/node_modules/')) return;
      return { contents: snapshotSource(path).toString('utf8'), loader: path.endsWith('.json') ? 'json' : path.endsWith('ts') ? 'ts' : 'js', resolveDir: dirname(input.path) };
    });
  } }],
  define: { 'process.env.WS_NO_BUFFER_UTIL': '"1"', 'process.env.WS_NO_UTF_8_VALIDATE': '"1"' },
  banner: { js: "import { createRequire as workerCreateRequire } from 'node:module'; const require = workerCreateRequire(import.meta.url);" } });
for (const source of Object.keys(built.metafile.inputs)) {
  if (!source.startsWith('node_modules/') && !source.includes('/node_modules/')) snapshotSource(source);
  if (source.startsWith('apps/api/') && !allowedApiModules.has(source)) throw new Error(`Forbidden control-plane import: ${source}`);
}
for (const entry of Object.values(built.metafile.outputs)) for (const dependency of entry.imports) {
  if (dependency.external && !isBuiltin(dependency.path)) throw new Error(`Unbundled dependency: ${dependency.path}`);
}
for (const name of ['installation.mjs', 'diagnostics.mjs', 'service.mjs', 'install-cli.mjs', 'runtime.mjs', 'setup.mjs', 'companion.mjs', 'setupInput.mjs', 'companionServer.mjs', 'companionService.mjs']) {
  await writeFile(join(output, 'src', name), snapshotSource(`apps/worker/src/${name}`), { mode: 0o600 });
}
await mkdir(join(output, 'artifacts'));
await writeFile(join(output, 'artifacts/graphql-worker.service.in'), snapshotSource('apps/worker/artifacts/graphql-worker.service.in'), { mode: 0o600 });
await writeFile(join(output, 'artifacts/companion.html'), snapshotSource('apps/worker/artifacts/companion.html'), { mode: 0o600 });
await writeFile(join(output, 'install'), snapshotSource('apps/worker/artifacts/install.sh.in').toString('utf8').replaceAll('@NODE_VERSION@', target.node), { mode: 0o700 });
if (runtime) await writeFile(join(output, 'artifacts/node-runtime.json'), snapshotSource(relative(root, resolve(runtimeFile))), { mode: 0o600 });
const files = [];
async function walk(directory, prefix = '') {
  for (const name of (await readdir(directory)).sort()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (name === 'src' || name === 'artifacts') { await walk(join(directory, name), path); continue; }
    const bytes = await readFile(join(directory, name)); files.push({ path, sha256: hash(bytes), size: bytes.length });
  }
}
await walk(output);
const pkg = JSON.parse(snapshotSource('apps/worker/package.json').toString('utf8'));
const manifest = { format: 1, version: pkg.version, commit, lockfileSha256: hash(snapshotSource('pnpm-lock.yaml')), packageManager: 'pnpm@11.27.0', protocolVersion: 1, identityFormat: 1, target, sourceSnapshot: { commit, files: [...snapshot.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, { gitBlobSha1, sha256 }]) => ({ path, gitBlobSha1, sha256 })) },
  ...(runtime ? { runtime: { metadataPath: 'artifacts/node-runtime.json', version: runtime.version, archiveSha256: runtime.archive.sha256, executableSha256: runtime.nodeExecutable.sha256, qualification: 'future installation requires actual target readback' } } : {}), files };
await writeFile(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ manifestSha256: hash(await readFile(join(output, 'manifest.json'))), version: pkg.version, commit: manifest.commit, files: files.length }));
