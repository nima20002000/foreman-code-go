import { readProductEnvironment } from '../../../packages/contracts/src/productEnvironment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, stat, readdir, rm, chmod, symlink, link, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { acquireWorkerLock } from '../src/runtime.mjs';

const artifact = readProductEnvironment(process.env, 'WORKER_ARTIFACT_DIRECTORY');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  // Capture requires persistent storage with private ancestors, including HOME.
  const directory = await mkdtemp(join('/var/tmp', 'job-runtime-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = join(directory, 'state'), base = join(directory, 'projects'), runtime = join(directory, 'managed');
  for (const path of [state, base, runtime]) await mkdir(path, { mode: 0o700 });
  const policyId = randomUUID(), source = join(runtime, 'source-materializations', policyId);
  await mkdir(source, { recursive: true, mode: 0o700 });
  const worker = await import(pathToFileURL(join(artifact, 'src/worker.mjs')).href);
  const keys = generateKeyPairSync('ed25519');
  const identity = { formatVersion: 1, workerInstallationId: randomUUID(), keyRevision: 1,
    publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyFingerprint: hash(keys.publicKey.export({ type: 'spki', format: 'der' })) };
  const pairing = { formatVersion: 1, mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: identity.workerInstallationId,
    keyRevision: 1, authorizationRevision: 3, endpoint: 'wss://fixture.invalid/device/connect', credential: 'a'.repeat(64),
    mainPublicKeyFingerprint: 'b'.repeat(64), expiresAt: '2099-01-01T00:00:00.000Z' };
  const hostRef = { kind: 'device', mainId: pairing.mainId, deviceId: pairing.deviceId };
  const approved = await worker.qualifyApprovedRootAllowlist({ schemaVersion: 1, hostRef, applicationInstallationId: identity.workerInstallationId,
    configurationRevision: '1', bases: [{ baseId: randomUUID(), canonicalPath: base, accessModes: ['read-write'] }], managedRuntimeRoot: runtime });
  const info = await stat(source, { bigint: true });
  const filesystem = { device: info.dev.toString(), inode: info.ino.toString(), mountId: approved.runtimeFilesystem.mountId };
  const registration = { workerInstallationId: identity.workerInstallationId, keyRevision: 1, authorizationRevision: 3 };
  const sourcePin = { approvedSourceId: randomUUID(), snapshotId: randomUUID(), manifestDigest: 'c'.repeat(64) };
  const root = { version: 1, source: sourcePin, selection: { hostRef, rootPolicyId: policyId, rootPolicyRevision: '1', locationRevision: '1' },
    binding: { version: 1, mainId: pairing.mainId, deviceId: pairing.deviceId, workerInstallationId: identity.workerInstallationId,
      workspaceId: 'workspace', rootId: randomUUID(), bindingRevision: 1, locationRevision: 1, canonicalPath: source, filesystem,
      accessMode: 'exclusive-write', snapshotId: sourcePin.snapshotId, manifestDigest: sourcePin.manifestDigest },
    ownerPrincipalId: 'owner', authorizedByPrincipalId: 'owner', registration, attestationId: 'attestation', attestationDigest: 'd'.repeat(64), boundAt: '2026-10-01T00:00:00.000Z' };
  const backingFile = join(directory, 'backing-metadata-fixture');
  await writeFile(backingFile, Buffer.alloc(4096), { mode: 0o400 });
  const executable = await realpath('/usr/bin/true');
  const input = { schemaVersion: 1, target: { hostRef, registration, mainInstallationId: pairing.mainId }, root,
    runtimeExecutable: executable, ociExecutable: executable, findmntExecutable: executable, runtimeRoot: runtime, backingFile,
    controllerEnvironment: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: directory, LANG: 'C.UTF-8' }, imageDigest: `sha256:${'e'.repeat(64)}`, toolchainDigest: 'f'.repeat(64), diskBytes: 4096 };
  for (const [name, value] of [['identity.json', identity], ['pairing.json', pairing], ['approved-roots.json', approved],
    ['workflow-operations.json', { retainedOriginal: 'workflow' }], ['job-runtime-operations.json', { retainedOriginal: 'job' }]]) {
    await writeFile(join(state, name), JSON.stringify(value), { mode: 0o600 });
  }
  const inputPath = join(directory, 'input.json'); await writeFile(inputPath, JSON.stringify(input), { mode: 0o600 });
  // Explicit metadata double for a privileged backing file; no sudo/provisioning or
  // real-runtime qualification. All CLI guards, source/binary pins and IO remain real.
  const hook = join(directory, 'backing-metadata-double.mjs');
  await writeFile(hook, `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
const original=fs.promises.open;
fs.promises.open=async function(path,...args){const handle=await original.call(this,path,...args);
if(path===${JSON.stringify(backingFile)}){const actual=handle.stat.bind(handle);handle.stat=async options=>{const info=await actual(options);info.uid=0n;info.mode=(info.mode&~0o222n);return info;};}
return handle;};syncBuiltinESMExports();\n`, { mode: 0o600 });
  const originalFiles = Object.fromEntries(await Promise.all((await readdir(state)).map(async name => [name, hash(await readFile(join(state, name)))])));
  const run = (args = [], metadataDouble = false) => spawnSync(process.execPath,
    [...(metadataDouble ? ['--import', hook] : []), join(artifact, 'src/cli.mjs'), 'capture-job-runtime', '--state', state, '--input', inputPath, ...args],
    { encoding: 'utf8', timeout: 15000, env: { PATH: '/usr/bin:/bin', HOME: directory, LANG: 'C.UTF-8' } });
  const unchanged = async () => {
    for (const [name, digest] of Object.entries(originalFiles)) assert.equal(hash(await readFile(join(state, name))), digest, name);
    assert.ok(!(await readdir(state)).some(name => name.startsWith('.job-runtime-')));
  };
  return { state, directory, runtime, input, inputPath, worker, originalFiles, run, unchanged };
}

test('packaged capture uses the passive helper, publishes protected pins once and retains original identity/journals', { skip: !artifact }, async t => {
  const f = await fixture(t);
  assert.equal(typeof f.worker.captureInstalledRuntimeConfiguration, 'function');
  // The unprivileged real backing file must be denied by the actual helper.
  await assert.rejects(f.worker.captureInstalledRuntimeConfiguration(f.input), /root-owned/);
  const result = f.run([], true);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { configurationPath: join(f.state, 'job-runtime.json'), captured: true, qualified: false, executionAuthorized: false });
  assert.equal(result.stderr, '');
  const path = join(f.state, 'job-runtime.json'), info = await stat(path), bytes = await readFile(path);
  assert.equal(info.uid, process.getuid()); assert.equal(info.mode & 0o777, 0o600); assert.equal(info.nlink, 1); assert.ok(info.size <= 65536);
  const output = JSON.parse(bytes);
  assert.equal(output.pins.runtimeBinarySha256, hash(await readFile(f.input.runtimeExecutable)));
  assert.equal(output.pins.diskBytes, f.input.diskBytes);
  assert.equal(output.pins.bootId, (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim());
  assert.match(output.pins.configurationDigest, /^[a-f0-9]{64}$/);
  for (const field of ['ready', 'measurement', 'qualified', 'credential']) assert.equal(field in output, false);
  assert.ok(!result.stdout.includes('a'.repeat(64)));
  const repeat = f.run([], true);
  assert.equal(repeat.status, 1); assert.equal(repeat.stderr.trim(), 'job_runtime_configuration_exists');
  assert.equal(hash(await readFile(path)), hash(bytes)); await f.unchanged();
});

test('packaged capture rejects private-file and destination violations without altering state', { skip: !artifact }, async t => {
  for (const kind of ['input-mode', 'input-symlink', 'input-hardlink', 'existing-output', 'output-symlink', 'missing-identity', 'missing-roots']) await t.test(kind, async child => {
    const f = await fixture(child);
    if (kind === 'input-mode') await chmod(f.inputPath, 0o644);
    if (kind === 'input-symlink') { await rm(f.inputPath); await symlink(join(f.state, 'pairing.json'), f.inputPath); }
    if (kind === 'input-hardlink') await link(f.inputPath, join(f.directory, 'input-alias'));
    if (kind === 'existing-output') await writeFile(join(f.state, 'job-runtime.json'), 'retained config', { mode: 0o600 });
    if (kind === 'output-symlink') await symlink(join(f.state, 'identity.json'), join(f.state, 'job-runtime.json'));
    if (kind === 'missing-identity') { await rm(join(f.state, 'identity.json')); delete f.originalFiles['identity.json']; }
    if (kind === 'missing-roots') { await rm(join(f.state, 'approved-roots.json')); delete f.originalFiles['approved-roots.json']; }
    const before = await readdir(f.state), result = f.run([], true);
    assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.ok(!result.stderr.includes('a'.repeat(64)));
    assert.deepEqual(await readdir(f.state), before); await f.unchanged();
    if (kind === 'existing-output') assert.equal(await readFile(join(f.state, 'job-runtime.json'), 'utf8'), 'retained config');
  });
});

test('packaged capture rejects caller pins, identity drift and roots outside the reviewed configuration', { skip: !artifact }, async t => {
  for (const kind of ['pins', 'ready', 'main', 'device', 'installation', 'authorization', 'runtime', 'source', 'stale-inode', 'read-only']) await t.test(kind, async child => {
    const f = await fixture(child), input = f.input;
    if (kind === 'pins') input.pins = {};
    if (kind === 'ready') input.ready = true;
    if (kind === 'main') input.target.mainInstallationId = randomUUID();
    if (kind === 'device') input.target.hostRef.deviceId = randomUUID();
    if (kind === 'installation') input.target.registration.workerInstallationId = randomUUID();
    if (kind === 'authorization') input.target.registration.authorizationRevision++;
    if (kind === 'runtime') input.runtimeRoot = f.directory;
    if (kind === 'source') input.root.binding.canonicalPath = f.directory;
    if (kind === 'stale-inode') input.root.binding.filesystem.inode = '0';
    if (kind === 'read-only') input.root.binding.accessMode = 'read-only';
    await writeFile(f.inputPath, JSON.stringify(input));
    const before = await readdir(f.state), result = f.run([], true);
    assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.deepEqual(await readdir(f.state), before); await f.unchanged();
  });
});

test('packaged capture refuses active worker ownership and unsupported overwrite/relative-input options', { skip: !artifact }, async t => {
  const f = await fixture(t), before = await readdir(f.state), unlock = await acquireWorkerLock(f.state);
  try { const result = f.run([], true); assert.equal(result.status, 1); assert.equal(result.stderr.trim(), 'worker_already_running'); }
  finally { await unlock(); }
  for (const args of [['--force'], ['--overwrite'], ['--input', 'relative.json']]) {
    const result = f.run(args, true); assert.equal(result.status, 1); assert.match(result.stderr, /usage/);
  }
  assert.deepEqual(await readdir(f.state), before); await f.unchanged();
});
