import { persistentFixtureRoot } from './fixtureStorage.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm, chmod, symlink, link, readdir, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { acquireWorkerLock } from '../src/runtime.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const bundleDirectory = await mkdtemp(join(persistentFixtureRoot, 'job-cleanup-test-bundle-'));
after(() => rm(bundleDirectory, { recursive: true, force: true }));
const exports = [
  ['apps/worker/src/jobCancellationCleanup.mjs', ['cleanupJobBeforeEntry', 'validateRestoredJobFilesystem']],
  ['apps/api/src/modules/runs/remote/operationJournal.ts', ['RemoteOperationJournal']],
  ['apps/api/src/modules/sources/materialization.ts', ['PrivateSourceMaterializer', 'releaseMaterializationClaimForCancellation']],
  ['apps/api/src/modules/sources/manifest.ts', ['createSourceManifest']],
  ['apps/api/src/modules/sources/bindingHash.ts', ['sourceBindingHash', 'sourceMaterializationDigest']],
  ['apps/api/src/modules/sources/privateFilesystem.ts', ['openPrivateRoot', 'identity']],
  ['apps/api/src/modules/sources/rootAttestation.ts', ['qualifyApprovedRootAllowlist']],
  ['packages/contracts/src/jobCancellationRecovery.ts', ['jobCancellationGrantMessage', 'jobCancellationClosureMessage']],
];
const contractPackage = JSON.parse(await readFile(join(repository, 'packages/contracts/package.json')));
const alias = Object.fromEntries(Object.entries(contractPackage.exports).map(([name, value]) => [
  name === '.' ? '@foreman-code/contracts' : `@foreman-code/contracts/${name.slice(2)}`,
  join(repository, 'packages/contracts', value.import.replace('./dist/', './src/').replace(/\.js$/, '.ts')),
]));
await build({ stdin: { contents: exports.map(([path, names]) =>
  `export { ${names.join(', ')} } from ${JSON.stringify(join(repository, path))};`).join('\n'), resolveDir: repository },
  outfile: join(bundleDirectory, 'cleanup.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node22', alias,
  banner: { js: "import { createRequire as testCreateRequire } from 'node:module'; const require = testCreateRequire(import.meta.url);" } });
await build({ entryPoints: [join(repository, 'apps/worker/src/cli.mjs')], outfile: join(bundleDirectory, 'cli.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node22', alias, external: ['sharp'],
  banner: { js: "import { createRequire as testCreateRequire } from 'node:module'; const require = testCreateRequire(import.meta.url);" } });
const worker = await import(pathToFileURL(join(bundleDirectory, 'cleanup.mjs')).href);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const directory = await mkdtemp(join(persistentFixtureRoot, 'job-cleanup-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = join(directory, 'state');
  const runtime = join(directory, 'managed');
  const base = join(directory, 'projects');
  for (const path of [state, runtime, base]) await mkdir(path, { mode: 0o700 });
  const keys = generateKeyPairSync('ed25519');
  const mainKeys = generateKeyPairSync('ed25519');
  const identity = { formatVersion: 1, workerInstallationId: randomUUID(), keyRevision: 1,
    publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyFingerprint: hash(keys.publicKey.export({ type: 'spki', format: 'der' })) };
  const pairing = { formatVersion: 1, mainId: randomUUID(), deviceId: randomUUID(),
    workerInstallationId: identity.workerInstallationId, keyRevision: 1, authorizationRevision: 1,
    endpoint: 'wss://fixture.invalid/device/connect', credential: 'a'.repeat(64),
    mainPublicKeyFingerprint: hash(mainKeys.publicKey.export({ type: 'spki', format: 'der' })),
    expiresAt: '2000-01-01T00:00:00.000Z' };
  const hostRef = { kind: 'device', mainId: pairing.mainId, deviceId: pairing.deviceId };
  const approved = await worker.qualifyApprovedRootAllowlist({ schemaVersion: 1, hostRef,
    applicationInstallationId: identity.workerInstallationId, configurationRevision: '1',
    bases: [{ baseId: randomUUID(), canonicalPath: base, accessModes: ['read-write'] }], managedRuntimeRoot: runtime });
  const policyId = randomUUID();
  const namespace = join(runtime, 'source-materializations', policyId);
  await mkdir(namespace, { recursive: true, mode: 0o700 });
  const handle = await worker.openPrivateRoot(namespace);
  let filesystem;
  try { filesystem = await worker.identity(handle); } finally { await handle.close(); }
  const bytes = Buffer.from('preserved committed-source fixture\n');
  const manifest = worker.createSourceManifest({ version: 1, approvedSourceId: randomUUID(), snapshotId: randomUUID(),
    capturePolicy: 'exclusive-explicit-bytes-v1', executablePolicy: 'strip',
    entries: [{ path: 'source.txt', kind: 'file', byteSize: bytes.length, sha256: hash(bytes), executable: false }], deletions: [] });
  const originalRegistration = { workerInstallationId: identity.workerInstallationId, keyRevision: 1, authorizationRevision: 1 };
  const sourcePin = { approvedSourceId: manifest.approvedSourceId, snapshotId: manifest.snapshotId,
    manifestDigest: manifest.manifestDigest };
  const root = { version: 1, source: sourcePin,
    selection: { hostRef, rootPolicyId: policyId, rootPolicyRevision: '1', locationRevision: '1' },
    binding: { version: 1, mainId: pairing.mainId, deviceId: pairing.deviceId,
      workerInstallationId: identity.workerInstallationId, workspaceId: 'workspace', rootId: randomUUID(),
      bindingRevision: 1, locationRevision: 1, canonicalPath: namespace, filesystem,
      accessMode: 'exclusive-write', snapshotId: manifest.snapshotId, manifestDigest: manifest.manifestDigest },
    registration: originalRegistration, ownerPrincipalId: 'owner', authorizedByPrincipalId: 'owner',
    attestationId: randomUUID(), attestationDigest: 'b'.repeat(64), boundAt: new Date().toISOString() };
  const operationId = randomUUID();
  const attempt = { executionId: randomUUID(), attemptId: randomUUID(), keyRevision: 1,
    authorizationRevision: 1, placementHash: '' };
  attempt.placementHash = worker.sourceBindingHash(root, attempt, operationId);
  const receipt = await new worker.PrivateSourceMaterializer({ read: async () => bytes }, async () => {})
    .prepare({ manifest, binding: root.binding, attempt });
  const materialization = { receipt, operationId, reservationId: randomUUID(), rootPolicyId: policyId,
    rootPolicyRevision: '1', sourceBindingHash: attempt.placementHash, finalDispatchBindingHash: 'c'.repeat(64), state: 'prepared' };
  const now = new Date().toISOString();
  const execution = { schemaVersion: 1, id: attempt.executionId, workspaceId: 'workspace', operationId,
    attemptId: attempt.attemptId, owner: { grantId: randomUUID(), epoch: '1' }, workflow: null,
    acceptedSpec: { source: { ...sourcePin, commit: 'd'.repeat(40), materializationId: receipt.materializationId,
      materializationDigest: worker.sourceMaterializationDigest(materialization) },
    target: { schemaVersion: 1, mainId: pairing.mainId, hostRef, registration: originalRegistration,
      mainInstallationId: pairing.mainId, destination: { canonicalProjectRoot: join(namespace, receipt.materializationId, 'tree'),
        canonicalCwd: join(namespace, receipt.materializationId, 'tree'), managedRuntimeRoot: runtime,
        directoryIdentityHash: 'e'.repeat(64), rootPolicyId: policyId, rootPolicyRevision: '1', locationRevision: '1',
        attestationId: root.attestationId, attestationHash: root.attestationDigest } },
    argv: ['node', 'source.txt'], inputs: [], outputs: [], workflowInput: null,
    policy: { isolationPolicyId: randomUUID(), isolationPolicyRevision: 1, imageDigest: `sha256:${'f'.repeat(64)}`,
      toolchainDigest: '1'.repeat(64), environmentScopeRefs: [], network: 'none', queueTimeoutMs: 10000,
      preparationTimeoutMs: 10000, executionTimeoutMs: 10000, cancellationGraceMs: 1000,
      maxLogChunkBytes: 1024, maxLogBytes: 4096, maxWorkerSpoolBytes: 4096, logOverflow: 'stop',
      maxOutputBytes: 4096, retentionSeconds: 3600 },
    definitionId: randomUUID(), definitionRevision: 1, definitionVersionId: randomUUID(), scriptDigest: '2'.repeat(64),
    outputSpecDigest: '3'.repeat(64), specDigest: '4'.repeat(64), bindingHash: 'c'.repeat(64) },
    process: { phase: 'queued', outcome: null, exitCode: null, signal: null, processStopped: false },
    transport: 'offline', publication: 'pending', startedAt: null, finishedAt: null, lastSeenAt: null,
    resultIssue: null, cancelRequestedAt: now, createdAt: now, updatedAt: now };
  const intent = { schemaVersion: 1, protocolVersion: 1, mainId: pairing.mainId,
    subject: { kind: 'manual-job', workspaceId: 'workspace', jobExecutionId: execution.id,
      definitionId: execution.acceptedSpec.definitionId }, executionId: execution.id, attemptId: execution.attemptId,
    operationId, bindingHash: execution.acceptedSpec.bindingHash,
    inputDigest: `sha256:${execution.acceptedSpec.specDigest}`, owner: execution.owner };
  const journalPath = join(state, 'job-runtime-operations.json');
  const journal = await worker.RemoteOperationJournal.open(journalPath, { initializeNewInstallation: true });
  await journal.jobAccept(intent, execution, { mainId: pairing.mainId, deviceId: pairing.deviceId,
    workerInstallationId: identity.workerInstallationId, keyRevision: 1, authorizationRevision: 1,
    bootId: randomUUID(), connectionGeneration: 1 }, randomUUID());
  await journal.close();
  for (const [name, value] of [['identity.json', identity], ['pairing.json', pairing], ['approved-roots.json', approved]])
    await writeFile(join(state, name), JSON.stringify(value), { mode: 0o600 });
  const grant = { schemaVersion: 1, kind: 'job-cancel-before-entry', id: randomUUID(), principalId: 'owner',
    approvedByPrincipalId: 'owner', approvedAt: now, expiresAt: new Date(Date.parse(now) + 300000).toISOString(),
    cancelCommandId: randomUUID(), journalSha256: hash(await readFile(journalPath)), intent, execution,
    registration: { mainId: pairing.mainId, deviceId: pairing.deviceId, workerInstallationId: identity.workerInstallationId,
      keyRevision: 1, authorizationRevision: 2, publicKeyFingerprint: identity.publicKeyFingerprint,
      status: 'revoked', scopes: ['connect', 'heartbeat'] }, root, materialization };
  const grantPath = join(directory, 'grant.json');
  const signedGrant = () => ({ grant, mainPublicKey: mainKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    signature: sign(null, Buffer.from(worker.jobCancellationGrantMessage(grant)), mainKeys.privateKey).toString('base64url') });
  const saveGrant = () => writeFile(grantPath, JSON.stringify(signedGrant()), { mode: 0o600 });
  await saveGrant();
  const claimPath = join(namespace, `binding-${root.binding.rootId}.lock`);
  const claim = await readFile(claimPath);
  const journalChange = async change => {
    const journal = await worker.RemoteOperationJournal.open(journalPath);
    try { await change(journal); } finally { await journal.close(); }
    grant.journalSha256 = hash(await readFile(journalPath));
    await saveGrant();
  };
  return { state, directory, namespace, grant, grantPath, saveGrant, claim, claimPath, journalPath, journalChange,
    keys, identity, pairing, sourcePath: join(namespace, receipt.materializationId, 'tree/source.txt'), bytes };
}

test('signed no-entry cleanup archives only the original claim and replays without touching its successor', async t => {
  const f = await fixture(t);
  const beforeIdentity = await readFile(join(f.state, 'identity.json'));
  const beforePairing = await readFile(join(f.state, 'pairing.json'));
  const result = await worker.cleanupJobBeforeEntry(f.state, f.grantPath);
  assert.equal(result.closure.receipt.entryAttempted, false);
  assert.equal(result.closure.receipt.stopFence, true);
  assert.equal(result.closure.receipt.terminal.outcome, 'cancelled');
  assert.equal(result.closure.receipt.native, undefined);
  assert.equal(result.closure.receipt.publication, 'complete');
  assert.ok(verify(null, Buffer.from(worker.jobCancellationClosureMessage(result.closure)),
    f.keys.publicKey, Buffer.from(result.signature, 'base64url')));
  const archived = await readFile(join(f.namespace, f.grant.materialization.receipt.materializationId, 'released-claim.json'));
  assert.deepEqual(archived, f.claim);
  assert.equal(result.closure.sourceClaim.archiveSha256, hash(archived));
  assert.deepEqual(await readFile(f.sourcePath), f.bytes);
  assert.deepEqual(await readFile(join(f.state, 'identity.json')), beforeIdentity);
  assert.deepEqual(await readFile(join(f.state, 'pairing.json')), beforePairing);
  const successor = Buffer.from('successor claim remains untouched');
  await writeFile(f.claimPath, successor, { mode: 0o600 });
  assert.deepEqual(await worker.cleanupJobBeforeEntry(f.state, f.grantPath), result);
  assert.deepEqual(await readFile(f.claimPath), successor);
});

for (const kind of ['signature', 'expired', 'future', 'long-life', 'installation', 'key', 'pairing', 'root',
  'filesystem', 'intent', 'source', 'missing-journal', 'recreated-journal', 'entry', 'native-owner',
  'private-mode', 'symlink', 'hardlink', 'missing-identity', 'public-as-private', 'worker-active', 'journal-active']) test(`cleanup rejects ${kind} and preserves the claim`, async t => {
  const f = await fixture(t);
  let unlock;
  let journal;
  if (kind === 'expired') f.grant.expiresAt = '2000-01-01T00:00:00.000Z';
  if (kind === 'future') f.grant.approvedAt = new Date(Date.now() + 100000).toISOString();
  if (kind === 'long-life') f.grant.expiresAt = new Date(Date.now() + 1000000).toISOString();
  if (kind === 'installation') f.grant.registration.workerInstallationId = randomUUID();
  if (kind === 'key') f.grant.registration.keyRevision++;
  if (kind === 'pairing') f.grant.root.registration.authorizationRevision++;
  if (kind === 'root') f.grant.root.binding.canonicalPath = f.directory;
  if (kind === 'filesystem') f.grant.root.binding.filesystem = { ...f.grant.root.binding.filesystem, inode: '0' };
  if (kind === 'intent') f.grant.intent.owner.grantId = randomUUID();
  if (kind === 'source') f.grant.materialization.receipt.executionId = randomUUID();
  await f.saveGrant();
  if (kind === 'signature') {
    const input = JSON.parse(await readFile(f.grantPath));
    input.signature = 'a'.repeat(86);
    await writeFile(f.grantPath, JSON.stringify(input));
  }
  if (kind === 'missing-journal') await rm(f.journalPath);
  if (kind === 'recreated-journal') await writeFile(f.journalPath,
    JSON.stringify({ schemaVersion: 1, receipts: [], qualificationReceipts: [], reconciliations: [], jobOwners: [] }));
  if (kind === 'entry') await f.journalChange(journal => journal.jobReserveEntry(f.grant.intent.operationId));
  if (kind === 'native-owner') await f.journalChange(async journal => {
    await journal.jobReserveEntry(f.grant.intent.operationId);
    await journal.jobReserveProcess(f.grant.intent.operationId, { launchId: randomUUID(), binary: '/usr/bin/true', argv: [] });
  });
  if (kind === 'private-mode') await chmod(f.grantPath, 0o644);
  if (kind === 'symlink') { await rm(f.grantPath); await symlink(join(f.state, 'pairing.json'), f.grantPath); }
  if (kind === 'hardlink') await link(f.grantPath, join(f.directory, 'grant-alias'));
  if (kind === 'missing-identity') await rm(join(f.state, 'identity.json'));
  if (kind === 'public-as-private') await writeFile(join(f.state, 'identity.json'),
    JSON.stringify({ ...f.identity, privateKey: f.identity.publicKey }));
  if (kind === 'worker-active') unlock = await acquireWorkerLock(f.state);
  if (kind === 'journal-active') journal = await worker.RemoteOperationJournal.open(f.journalPath);
  const failedJournalBytes = kind === 'recreated-journal' ? await readFile(f.journalPath) : null;
  try { await assert.rejects(worker.cleanupJobBeforeEntry(f.state, f.grantPath)); }
  finally { await journal?.close(); await unlock?.(); }
  assert.deepEqual(await readFile(f.claimPath), f.claim);
  assert.deepEqual(await readFile(f.sourcePath), f.bytes);
  assert.ok(!(await readdir(f.state)).some(name => name.endsWith('.owner-lock')));
  if (kind === 'missing-journal') await assert.rejects(readFile(f.journalPath), { code: 'ENOENT' });
  if (failedJournalBytes) assert.deepEqual(await readFile(f.journalPath), failedJournalBytes);
});

test('a real live source-namespace process blocks release after the durable stop fence', async t => {
  const f = await fixture(t);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: f.namespace, stdio: 'ignore' });
  const closed = new Promise(resolve => child.once('close', resolve));
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  try {
    await assert.rejects(worker.cleanupJobBeforeEntry(f.state, f.grantPath));
    assert.deepEqual(await readFile(f.claimPath), f.claim);
  } finally { child.kill('SIGTERM'); await closed; }
  const result = await worker.cleanupJobBeforeEntry(f.state, f.grantPath);
  assert.equal(result.closure.receipt.terminal.outcome, 'cancelled');
});

test('CLI returns only the signed closure and keeps failures and secrets off stdout', async t => {
  const f = await fixture(t);
  const run = args => spawnSync(process.execPath, [join(bundleDirectory, 'cli.mjs'),
    'cleanup-job-before-entry', '--state', f.state, '--grant', f.grantPath, ...args],
  { encoding: 'utf8', timeout: 15000 });
  const result = run([]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const response = JSON.parse(result.stdout);
  assert.equal(response.closure.grantId, f.grant.id);
  assert.ok(!result.stdout.includes(f.pairing.credential));
  assert.ok(!result.stdout.includes(f.identity.privateKey));
  const invalid = run(['--force', 'yes']);
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, '');
  assert.match(invalid.stderr, /usage/);
  f.grant.expiresAt = '2000-01-01T00:00:00.000Z';
  await f.saveGrant();
  const expired = run([]);
  assert.equal(expired.status, 1);
  assert.equal(expired.stdout, '');
  assert.equal(expired.stderr.trim(), 'job_cleanup_grant_expired');
});

function restoredVolumeObservation() {
  // Explicit passive-observation unit fixture; this is not a mounted-volume or native qualification result.
  const filesystemUuid = randomUUID();
  const filesystem = { device: '1793', inode: '200', mountId: '41' };
  const path = '/var/lib/graphql-ci/retained.ext4';
  const context = { kind: 'restored-original-volume', bootId: randomUUID(), filesystemUuid, filesystem,
    backingFile: { path, device: '2049', inode: '300', bytes: '4096' } };
  const superblock = Buffer.alloc(1024);
  superblock.writeUInt16LE(0xef53, 56);
  Buffer.from(filesystemUuid.replaceAll('-', ''), 'hex').copy(superblock, 104);
  const configuration = { root: { binding: { filesystem: { device: '1792', inode: '200', mountId: '40' } } },
    backingFile: path, pins: { diskBytes: 4096 } };
  const observed = { bootId: context.bootId, filesystem, backingPath: path, loopBackingPath: path,
    loopOffset: '0', loopSizeLimit: '0', mountinfo: '41 10 7:1 / /retained rw - ext4 /dev/loop1 rw\n',
    backingStat: { regular: true, ownerUid: 0, mode: 0o100440, links: 1, device: '2049', inode: '300', bytes: '4096' },
    superblock };
  return { context, configuration, observed };
}

test('restored-volume validation joins current boot, kernel mount, original backing identity and ext4 UUID', () => {
  const { context, configuration, observed } = restoredVolumeObservation();
  assert.equal(worker.validateRestoredJobFilesystem(context, configuration, observed), '7:1');
});

for (const kind of ['boot', 'root-inode', 'mount-id', 'non-loop', 'non-ext4', 'loop-source', 'duplicate-mount',
  'backing-path', 'configured-path', 'loop-path', 'offset', 'size-limit', 'owner', 'writable', 'hardlink',
  'backing-inode', 'backing-device', 'backing-size', 'configured-size', 'magic', 'uuid']) {
  test(`restored-volume observations reject changed ${kind}`, () => {
    const { context, configuration, observed } = restoredVolumeObservation();
    if (kind === 'boot') observed.bootId = randomUUID();
    if (kind === 'root-inode') observed.filesystem = { ...observed.filesystem, inode: '999' };
    if (kind === 'mount-id') observed.mountinfo = observed.mountinfo.replace('41 ', '42 ');
    if (kind === 'non-loop') observed.mountinfo = observed.mountinfo.replace('7:1', '8:1');
    if (kind === 'non-ext4') observed.mountinfo = observed.mountinfo.replace('ext4', 'xfs');
    if (kind === 'loop-source') observed.mountinfo = observed.mountinfo.replace('/dev/loop1', '/dev/loop2');
    if (kind === 'duplicate-mount') observed.mountinfo += observed.mountinfo;
    if (kind === 'backing-path') context.backingFile.path = '/var/lib/graphql-ci/replacement.ext4';
    if (kind === 'configured-path') configuration.backingFile = '/var/lib/graphql-ci/replacement.ext4';
    if (kind === 'loop-path') observed.loopBackingPath = '/var/lib/graphql-ci/replacement.ext4';
    if (kind === 'offset') observed.loopOffset = '1024';
    if (kind === 'size-limit') observed.loopSizeLimit = '2048';
    if (kind === 'owner') observed.backingStat.ownerUid = 1000;
    if (kind === 'writable') observed.backingStat.mode |= 0o020;
    if (kind === 'hardlink') observed.backingStat.links = 2;
    if (kind === 'backing-inode') observed.backingStat.inode = '301';
    if (kind === 'backing-device') observed.backingStat.device = '2050';
    if (kind === 'backing-size') observed.backingStat.bytes = '8192';
    if (kind === 'configured-size') configuration.pins.diskBytes = 8192;
    if (kind === 'magic') observed.superblock.writeUInt16LE(0, 56);
    if (kind === 'uuid') observed.superblock[104] ^= 1;
    assert.throws(() => worker.validateRestoredJobFilesystem(context, configuration, observed));
  });
}

test('a signed filesystem context cannot turn the actual non-loop fixture root into an approved restored volume', async t => {
  const f = await fixture(t);
  const backingFile = join(f.directory, 'backing.ext4');
  const installation = { schemaVersion: 1,
    target: { hostRef: f.grant.execution.acceptedSpec.target.hostRef, registration: f.grant.root.registration,
      mainInstallationId: f.pairing.mainId }, root: f.grant.root,
    runtimeExecutable: '/usr/bin/true', ociExecutable: '/usr/bin/true', findmntExecutable: '/usr/bin/true',
    runtimeRoot: f.grant.execution.acceptedSpec.target.destination.managedRuntimeRoot, backingFile,
    controllerEnvironment: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: f.directory, LANG: 'C.UTF-8' },
    pins: { bootId: randomUUID(), runtimeBinarySha256: '1'.repeat(64), ociBinarySha256: '2'.repeat(64),
      findmntBinarySha256: '3'.repeat(64), configurationDigest: '4'.repeat(64), imageDigest: `sha256:${'5'.repeat(64)}`,
      toolchainDigest: '6'.repeat(64), diskBytes: 4096 } };
  await writeFile(join(f.state, 'job-runtime.json'), JSON.stringify(installation), { mode: 0o600 });
  f.grant.filesystemRecovery = { kind: 'restored-original-volume', bootId: randomUUID(), filesystemUuid: randomUUID(),
    filesystem: f.grant.root.binding.filesystem,
    backingFile: { path: backingFile, device: '1', inode: '1', bytes: '4096' } };
  await f.saveGrant();
  await assert.rejects(worker.cleanupJobBeforeEntry(f.state, f.grantPath), { code: 'job_cleanup_original_volume_required' });
  assert.deepEqual(await readFile(f.claimPath), f.claim);
});

test('the cancellation-specific archive rejects changed original source bytes', async t => {
  const f = await fixture(t);
  await writeFile(f.sourcePath, 'changed original source');
  await assert.rejects(worker.releaseMaterializationClaimForCancellation(f.grant.materialization.receipt,
    f.grant.root.binding.filesystem, async () => 'released'));
  assert.deepEqual(await readFile(f.claimPath), f.claim);
});

test('the cancellation-specific archive rejects a replaced original namespace inode', async t => {
  const f = await fixture(t);
  const retained = `${f.namespace}-retained`;
  await rename(f.namespace, retained);
  await mkdir(f.namespace, { mode: 0o700 });
  await assert.rejects(worker.releaseMaterializationClaimForCancellation(f.grant.materialization.receipt,
    f.grant.root.binding.filesystem, async () => 'released'));
  assert.deepEqual(await readFile(join(retained, `binding-${f.grant.root.binding.rootId}.lock`)), f.claim);
});
