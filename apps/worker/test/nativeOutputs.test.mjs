import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { acquireWorkerLock, readWorkerStatus } from '../src/runtime.mjs';
import { hostFacts } from '../src/diagnostics.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const bundle = await mkdtemp('/var/tmp/native-output-worker-bundle-');
after(() => rm(bundle, { recursive: true, force: true }));
const contracts = JSON.parse(await readFile(join(repository, 'packages/contracts/package.json')));
const alias = Object.fromEntries(Object.entries(contracts.exports).map(([name, value]) => [
  name === '.' ? '@foreman-code/contracts' : `@foreman-code/contracts/${name.slice(2)}`,
  join(repository, 'packages/contracts', value.import.replace('./dist/', './src/').replace(/\.js$/, '.ts')),
]));
const buildOptions = { bundle: true, platform: 'node', format: 'esm', target: 'node22', alias,
  external: ['sharp'], banner: { js:
    "import { createRequire as testCreateRequire } from 'node:module'; const require = testCreateRequire(import.meta.url);" } };
await build({ ...buildOptions, entryPoints: {
  cli: join(repository, 'apps/worker/src/cli.mjs'),
  worker: join(repository, 'apps/worker/src/workerFactory.mjs'),
}, outdir: join(bundle, 'src'), outExtension: { '.js': '.mjs' } });
await build({ ...buildOptions, stdin: { contents: [
  "export { createNativeOutputBudgetLedger } from './apps/api/src/modules/runs/remote/installedNativeOutputStorage.ts';",
  "export { acquireNativeOutputBudgetLock } from './apps/api/src/modules/runs/remote/nativeOutputBudgetLock.ts';",
  "export { openPrivateRoot } from './apps/api/src/modules/sources/privateFilesystem.ts';",
  "export { nativeOutputBudgetLimits } from './apps/api/src/modules/runs/remote/installedWorkflowOutputStore.ts';",
].join('\n'), resolveDir: repository }, outfile: join(bundle, 'src/ports.mjs') });
const worker = await import(pathToFileURL(join(bundle, 'src/worker.mjs')).href);
const ports = await import(pathToFileURL(join(bundle, 'src/ports.mjs')).href);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const facts = await hostFacts(bundle, [bundle]);
const cliBytes = await readFile(join(bundle, 'src/cli.mjs'));
await writeFile(join(bundle, 'manifest.json'), JSON.stringify({ format: 1, version: '0.1.0',
  protocolVersion: 1, identityFormat: 1, commit: 'a'.repeat(40), lockfileSha256: 'b'.repeat(64),
  packageManager: 'pnpm@11.27.0', target: facts,
  files: [{ path: 'src/cli.mjs', size: cliBytes.length, sha256: hash(cliBytes) }] }), { mode: 0o600 });

async function fixture(t) {
  const directory = await mkdtemp('/var/tmp/native-output-worker-state-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = join(directory, 'state');
  await mkdir(state, { mode: 0o700 });
  const keys = generateKeyPairSync('ed25519');
  const identity = { formatVersion: 1, workerInstallationId: randomUUID(), keyRevision: 1,
    publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyFingerprint: hash(keys.publicKey.export({ type: 'spki', format: 'der' })) };
  const pairing = { formatVersion: 1, mainId: randomUUID(), deviceId: randomUUID(),
    workerInstallationId: identity.workerInstallationId, keyRevision: 1, authorizationRevision: 1,
    endpoint: 'wss://fixture.invalid/device/connect', credential: 'a'.repeat(64),
    mainPublicKeyFingerprint: 'b'.repeat(64), expiresAt: '2099-01-01T00:00:00.000Z' };
  await writeFile(join(state, 'identity.json'), JSON.stringify(identity), { mode: 0o600 });
  await writeFile(join(state, 'pairing.json'), JSON.stringify(pairing), { mode: 0o600 });
  const environment = { PATH: '/usr/bin:/bin', HOME: directory, LANG: 'C.UTF-8' };
  const cli = (extra = []) => spawnSync(process.execPath,
    [...extra, join(bundle, 'src/cli.mjs'), 'initialize-native-outputs', '--state', state],
    { encoding: 'utf8', timeout: 20_000, env: environment });
  const budget = join(state, 'workflow-native-outputs', 'budget');
  const installation = { mainId: pairing.mainId, deviceId: pairing.deviceId,
    workerInstallationId: pairing.workerInstallationId };
  const openLedger = () => ports.createNativeOutputBudgetLedger({ rootDirectory: budget,
    installation, limits: ports.nativeOutputBudgetLimits });
  const owner = { intent: { schemaVersion: 1, protocolVersion: 1, mainId: pairing.mainId,
    runId: 'run', nodeId: 'node', executionId: 'execution', occurrenceId: null, occurrenceIndex: 0,
    technicalAttempt: 1, attemptId: 'attempt', operationId: 'operation', bindingHash: 'c'.repeat(64),
    inputDigest: `sha256:${'d'.repeat(64)}`, owner: { grantId: 'grant', epoch: '1' } },
  binding: { ...installation, keyRevision: 1, authorizationRevision: 1, bootId: randomUUID(),
    connectionEpoch: randomUUID(), connectionGeneration: 1 },
  session: { harness: 'codex', providerVersion: 'codex-cli 0.154.0', nativeSessionId: 'native-session' },
  nativeTurnId: 'original-turn', runtimeGeneration: 1 };
  return { directory, state, pairing, installation, environment, cli, budget, openLedger, owner };
}

test('bundled initializer verifies paired stopped ownership, preserves charges, and launches no connection', async t => {
  const f = await fixture(t);
  assert.equal(typeof worker.initializeInstalledNativeOutputs, 'function');
  const first = f.cli();
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout), { nativeOutputs: 'initialized', executionAuthorized: false });
  assert.equal(await readWorkerStatus(f.state), null);
  const original = { owner: f.owner, artifactId: randomUUID(), limits: ports.nativeOutputBudgetLimits,
    requested: ports.nativeOutputBudgetLimits };
  const reservation = await (await f.openLedger()).reserve(original);
  const retained = await readFile(join(f.budget, '.native-output-budget.json'), 'utf8');
  const repeat = f.cli();
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.equal(await readFile(join(f.budget, '.native-output-budget.json'), 'utf8'), retained);
  await reservation.assertCurrent();
  await assert.rejects((await f.openLedger()).reserve({ ...original, artifactId: randomUUID() }));
  assert.equal(await readWorkerStatus(f.state), null);
  assert.ok(!(await readdir(f.state)).includes('workflow-operations.json'));
});

test('initializer rejects active, mismatched, unpaired and exposed installations before creating output state', async t => {
  for (const kind of ['active', 'mismatched', 'unpaired', 'exposed']) await t.test(kind, async child => {
    const f = await fixture(child);
    let unlock;
    if (kind === 'active') unlock = await acquireWorkerLock(f.state);
    if (kind === 'mismatched') await writeFile(join(f.state, 'pairing.json'),
      JSON.stringify({ ...f.pairing, workerInstallationId: randomUUID() }), { mode: 0o600 });
    if (kind === 'unpaired') await rm(join(f.state, 'pairing.json'));
    if (kind === 'exposed') await chmod(join(f.state, 'pairing.json'), 0o644);
    try {
      const result = f.cli();
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      if (kind === 'active') assert.equal(result.stderr.trim(), 'worker_already_running');
      await assert.rejects(readFile(join(f.state, 'workflow-native-outputs-initialized.json')), { code: 'ENOENT' });
    } finally {
      await unlock?.();
    }
  });
});

const crashBoundaries = ['progress-write', 'progress-published', 'root-created', 'budget-created', 'turns-created',
  'owner-published', 'budget-write', 'budget-published', 'completion-write', 'completion-published'];

async function crashHook(f, boundary) {
  const hook = join(f.directory, 'crash-hook.mjs');
  // Fault injection follows successful real filesystem operations; it does not replace their results.
  await writeFile(hook, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const original = { open: fs.promises.open, mkdir: fs.promises.mkdir, rename: fs.promises.rename,
  realpath: fs.promises.realpath, readFile: fs.promises.readFile };
const boundary = ${JSON.stringify(boundary)};
const crash = value => { if (value === boundary) process.kill(process.pid, 'SIGKILL'); };
let markers = 0;
fs.promises.mkdir = async (path, ...args) => {
  const result = await original.mkdir(path, ...args);
  const canonical = await original.realpath(path);
  if (canonical.endsWith('/workflow-native-outputs')) crash('root-created');
  if (canonical.endsWith('/workflow-native-outputs/budget')) crash('budget-created');
  if (canonical.endsWith('/workflow-native-outputs/turns')) crash('turns-created');
  return result;
};
fs.promises.rename = async (source, destination) => {
  const result = await original.rename(source, destination);
  const canonical = await original.realpath(destination);
  if (canonical.endsWith('/workflow-native-outputs-initialized.json')) {
    markers++;
    crash(markers === 1 ? 'progress-published' : 'completion-published');
  }
  if (canonical.endsWith('/.native-output-budget-owner.json')) crash('owner-published');
  if (canonical.endsWith('/.native-output-budget.json')) crash('budget-published');
  return result;
};
fs.promises.open = async (path, ...args) => {
  const file = await original.open(path, ...args);
  const canonical = await original.realpath(path);
  const sync = file.sync.bind(file);
  file.sync = async () => {
    await sync();
    if (canonical.includes('/.workflow-native-outputs-initialized.json-') && canonical.endsWith('.tmp')) {
      const marker = JSON.parse(await original.readFile(path, 'utf8'));
      crash(marker.phase === 'initializing' ? 'progress-write' : 'completion-write');
    }
    const name = canonical.slice(canonical.lastIndexOf('/') + 1);
    if (name.startsWith('.native-output-budget-') && !name.startsWith('.native-output-budget-owner-')
      && name.endsWith('.tmp')) crash('budget-write');
  };
  return file;
};
syncBuiltinESMExports();
`, { mode: 0o600 });
  return hook;
}

test('bundled initialization resumes after SIGKILL at every publication boundary', async t => {
  for (const boundary of crashBoundaries) await t.test(boundary, async child => {
    const f = await fixture(child);
    const hook = await crashHook(f, boundary);
    const crashed = f.cli(['--import', hook]);
    assert.equal(crashed.signal, 'SIGKILL', `${boundary}: ${crashed.stderr}`);
    assert.equal(crashed.stdout, '');
    const resumed = f.cli();
    assert.equal(resumed.status, 0, `${boundary}: ${resumed.stderr}`);
    const marker = JSON.parse(await readFile(join(f.state, 'workflow-native-outputs-initialized.json'), 'utf8'));
    assert.equal(marker.phase, 'complete');
    const original = { owner: f.owner, artifactId: randomUUID(), limits: ports.nativeOutputBudgetLimits,
      requested: ports.nativeOutputBudgetLimits };
    await (await (await f.openLedger()).reserve(original)).assertCurrent();
    assert.equal(await readWorkerStatus(f.state), null);
  });
});

test('SIGKILL releases the kernel budget lock, retires ownership and retains original native charges', async t => {
  const f = await fixture(t);
  await worker.initializeInstalledNativeOutputs(f.state);
  const original = { owner: f.owner, artifactId: randomUUID(), limits: ports.nativeOutputBudgetLimits,
    requested: ports.nativeOutputBudgetLimits };
  await (await f.openLedger()).reserve(original);
  const retained = await readFile(join(f.budget, '.native-output-budget.json'), 'utf8');
  const script = `import { acquireNativeOutputBudgetLock, openPrivateRoot } from ${JSON.stringify(
    pathToFileURL(join(bundle, 'src/ports.mjs')).href)};
const root = await openPrivateRoot(${JSON.stringify(f.budget)});
await acquireNativeOutputBudgetLock(root);
process.kill(process.pid, 'SIGKILL');`;
  const crashed = spawnSync(process.execPath, ['--input-type=module', '-e', script],
    { encoding: 'utf8', timeout: 5000, env: f.environment });
  assert.equal(crashed.signal, 'SIGKILL', crashed.stderr);
  const staleOwner = JSON.parse(await readFile(join(f.budget, '.native-output-budget-owner.json'), 'utf8'));
  const restarted = f.cli();
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.equal(await readFile(join(f.budget, '.native-output-budget.json'), 'utf8'), retained);
  const retired = JSON.parse(await readFile(join(f.budget,
    `.native-output-budget-retired-owner-${staleOwner.ownerId}.json`), 'utf8'));
  assert.deepEqual(retired, staleOwner);
  await (await (await f.openLedger()).reserve(original)).assertCurrent();
  await assert.rejects((await f.openLedger()).reserve({ ...original, artifactId: randomUUID() }));
});

test('restart keeps the committed budget transaction across SIGKILL before and after publication', async t => {
  for (const boundary of ['budget-write', 'budget-published']) await t.test(boundary, async child => {
    const f = await fixture(child);
    await worker.initializeInstalledNativeOutputs(f.state);
    const requested = { maxDiskBytes: 1, maxSnapshotBytes: 1, maxCommandRecords: 1 };
    const first = { owner: f.owner, artifactId: randomUUID(), limits: ports.nativeOutputBudgetLimits, requested };
    const second = { ...first, artifactId: randomUUID(), owner: { ...f.owner, nativeTurnId: 'second-turn' } };
    await (await f.openLedger()).reserve(first);
    const hook = await crashHook(f, boundary);
    const script = `import { createNativeOutputBudgetLedger } from ${JSON.stringify(
      pathToFileURL(join(bundle, 'src/ports.mjs')).href)};
const ledger = await createNativeOutputBudgetLedger(${JSON.stringify({ rootDirectory: f.budget,
      installation: f.installation, limits: ports.nativeOutputBudgetLimits })});
await ledger.reserve(${JSON.stringify(second)});`;
    const crashed = spawnSync(process.execPath, ['--import', hook, '--input-type=module', '-e', script],
      { encoding: 'utf8', timeout: 5000, env: f.environment });
    assert.equal(crashed.signal, 'SIGKILL', crashed.stderr);
    const restarted = f.cli();
    assert.equal(restarted.status, 0, restarted.stderr);
    const journal = JSON.parse(await readFile(join(f.budget, '.native-output-budget.json'), 'utf8'));
    assert.deepEqual(journal.payload.records.map(record => record.artifactId),
      boundary === 'budget-write' ? [first.artifactId] : [first.artifactId, second.artifactId]);
    const recovered = await f.openLedger();
    await (await recovered.reserve(first)).assertCurrent();
    await (await recovered.reserve(second)).assertCurrent();
    await assert.rejects(recovered.reserve({ ...first, artifactId: randomUUID(),
      requested: ports.nativeOutputBudgetLimits }));
  });
});
