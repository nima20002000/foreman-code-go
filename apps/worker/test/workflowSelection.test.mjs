import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { chmod, copyFile, link, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile }
  from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { persistentFixtureRoot } from './fixtureStorage.mjs';
import { acquireWorkerLock } from '../src/runtime.mjs';

let bundleDirectory;
let refreshWorkflowSelection;
before(async () => {
  bundleDirectory = await mkdtemp(join(persistentFixtureRoot, 'workflow-selection-module-'));
  const output = join(bundleDirectory, 'selection.mjs');
  const { build } = createRequire(import.meta.url)('esbuild');
  await build({ entryPoints: [new URL('../src/workflowSelection.mjs', import.meta.url).pathname],
    outfile: output, bundle: true, platform: 'node', format: 'esm',
    banner: { js: "import { createRequire as workerCreateRequire } from 'node:module'; const require = workerCreateRequire(import.meta.url);" } });
  ({ refreshWorkflowSelection } = await import(pathToFileURL(output).href));
});
after(async () => { await rm(bundleDirectory, { recursive: true, force: true }); });

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(persistentFixtureRoot, 'workflow-selection-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDirectory = join(root, 'state');
  const release = join(root, 'release');
  const bin = join(root, 'bin');
  for (const path of [stateDirectory, join(release, 'artifacts'), bin]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
  await writeFile(join(release, 'artifacts/graphql-mcp.mjs'), 'export {};', { mode: 0o600 });
  const unlock = await acquireWorkerLock(stateDirectory);
  t.after(unlock);
  const options = { stateDirectory, release, environment: { PATH: bin }, assertStateOwnership: unlock.assertOwned };
  return { root, bin, release, stateDirectory, options, path: join(stateDirectory, 'workflow-runtime.json') };
}

async function nativeCodex(binary, version = '0.162.0') {
  await mkdir(dirname(binary), { recursive: true, mode: 0o700 });
  execFileSync('/usr/bin/cc', ['-x', 'c', '-o', binary, '-'], {
    input: `#include <stdio.h>\nint main(void) { puts("codex-cli ${version}"); return 0; }\n`,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

test('paired selection publishes a private native Codex selection with the current release launcher', async t => {
  const f = await fixture(t);
  const binary = join(f.bin, 'codex');
  await nativeCodex(binary);
  const location = await refreshWorkflowSelection(f.options);
  assert.deepEqual(location, { path: f.path, ownerUid: process.getuid() });
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')), { schemaVersion: 1, codexBinary: binary,
    expectedVersion: 'codex-cli 0.162.0', payloadPaths: [],
    appMcpLauncher: join(f.release, 'artifacts/graphql-mcp.mjs') });
  const info = await stat(f.path);
  assert.equal(info.uid, process.getuid());
  assert.equal(info.mode & 0o777, 0o600);
  assert.equal(info.nlink, 1);
  await refreshWorkflowSelection(f.options);
  assert.equal((await stat(f.path)).ino, info.ino, 'unchanged selections are not rewritten');
});

test('resolves an upgraded npm Codex launcher to its native optional package without executing the script', async t => {
  const f = await fixture(t);
  const packageDirectory = join(f.root, 'node_modules/@openai/codex');
  const launcher = join(packageDirectory, 'bin/codex.js');
  const platformPackage = join(packageDirectory, `node_modules/@openai/codex-${process.platform}-${process.arch}`);
  const architecture = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const binary = join(platformPackage, `vendor/${architecture}-unknown-linux-musl/bin/codex`);
  await nativeCodex(binary);
  await mkdir(dirname(launcher), { recursive: true });
  await writeFile(launcher, '#!/usr/bin/env node\nthrow new Error("Do not execute npm wrapper");', { mode: 0o700 });
  await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({ name: '@openai/codex', version: '0.162.0' }));
  await writeFile(join(platformPackage, 'package.json'), JSON.stringify({ name: `@openai/codex-${process.platform}-${process.arch}` }));
  await symlink(launcher, join(f.bin, 'codex'));
  await refreshWorkflowSelection(f.options);
  const selection = JSON.parse(await readFile(f.path, 'utf8'));
  assert.equal(selection.codexBinary, binary);
  assert.deepEqual(selection.payloadPaths, [launcher, join(packageDirectory, 'package.json')]);
  assert.equal(selection.expectedVersion, 'codex-cli 0.162.0');
  await nativeCodex(binary, '0.163.0');
  await refreshWorkflowSelection(f.options);
  assert.equal(JSON.parse(await readFile(f.path, 'utf8')).expectedVersion, 'codex-cli 0.163.0');
});

for (const ambientHarness of ['absent', 'different']) {
  test(`keeps an explicit Codex selection when PATH discovery is ${ambientHarness}`, async t => {
    const f = await fixture(t);
    const binary = join(f.root, 'selected/codex');
    await nativeCodex(binary);
    if (ambientHarness === 'different') await nativeCodex(join(f.bin, 'codex'), '0.163.0');
    const payload = join(f.root, 'selected/payload.json');
    await writeFile(payload, '{}');
    const selection = { schemaVersion: 1, codexBinary: binary, expectedVersion: 'codex-cli 0.162.0',
      payloadPaths: [payload], appMcpLauncher: join(f.release, 'artifacts/graphql-mcp.mjs') };
    const bytes = JSON.stringify(selection);
    await writeFile(f.path, bytes, { mode: 0o600 });
    const info = await stat(f.path);
    assert.deepEqual(await refreshWorkflowSelection(f.options), { path: f.path, ownerUid: process.getuid() });
    assert.equal(await readFile(f.path, 'utf8'), bytes);
    assert.equal((await stat(f.path)).ino, info.ino);

    await nativeCodex(binary, '0.164.0');
    await refreshWorkflowSelection(f.options);
    assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')), {
      ...selection, expectedVersion: 'codex-cli 0.164.0',
    });
    await rm(binary);
    if (ambientHarness === 'different') {
      await refreshWorkflowSelection(f.options);
      assert.equal(JSON.parse(await readFile(f.path, 'utf8')).codexBinary, join(f.bin, 'codex'));
    } else {
      assert.equal(await refreshWorkflowSelection(f.options), null);
      await assert.rejects(readFile(f.path), { code: 'ENOENT' });
    }
  });
}

test('a retained selection follows the running release launcher after a Worker update', async t => {
  const f = await fixture(t);
  const previous = join(f.root, 'versions/1'), current = join(f.root, 'versions/2');
  for (const release of [previous, current]) {
    await mkdir(join(release, 'artifacts'), { recursive: true, mode: 0o700 });
    await writeFile(join(release, 'artifacts/graphql-mcp.mjs'), 'export {};', { mode: 0o600 });
  }
  const binary = join(f.root, 'selected/codex');
  await nativeCodex(binary);
  await writeFile(f.path, JSON.stringify({ schemaVersion: 1, codexBinary: binary, expectedVersion: 'codex-cli 0.162.0',
    payloadPaths: [], appMcpLauncher: join(previous, 'artifacts/graphql-mcp.mjs') }), { mode: 0o600 });
  await refreshWorkflowSelection({ ...f.options, release: current });
  const selection = JSON.parse(await readFile(f.path, 'utf8'));
  assert.equal(selection.codexBinary, binary);
  assert.equal(selection.appMcpLauncher, join(current, 'artifacts/graphql-mcp.mjs'));
});

test('an absent or removed harness is not selected and retired launchers are replaced', async t => {
  const f = await fixture(t);
  assert.equal(await refreshWorkflowSelection(f.options), null);
  await assert.rejects(readFile(f.path), { code: 'ENOENT' });
  await writeFile(f.path, JSON.stringify({ schemaVersion: 1, codexBinary: '/retired/codex',
    expectedVersion: 'codex-cli 0.154.0', payloadPaths: [], appMcpLauncher: '/retired/launcher.mjs' }), { mode: 0o600 });
  await nativeCodex(join(f.bin, 'codex'));
  await refreshWorkflowSelection(f.options);
  assert.equal(JSON.parse(await readFile(f.path, 'utf8')).appMcpLauncher, join(f.release, 'artifacts/graphql-mcp.mjs'));
  await rm(join(f.bin, 'codex'));
  assert.equal(await refreshWorkflowSelection(f.options), null);
  await assert.rejects(readFile(f.path), { code: 'ENOENT' });
});

test('selects installed Claude with its actual SDK integrity metadata without requiring Codex', async t => {
  const f = await fixture(t);
  const sdkDirectory = join(f.release,
    'node_modules/.pnpm/@anthropic-ai+claude-agent-sdk@0.3.284/node_modules/@anthropic-ai/claude-agent-sdk');
  await mkdir(sdkDirectory, { recursive: true });
  await writeFile(join(sdkDirectory, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk',
    version: '0.3.284', main: 'sdk.mjs' }));
  await writeFile(join(sdkDirectory, 'sdk.mjs'), 'export {};');
  await mkdir(join(f.release, 'node_modules/@anthropic-ai'), { recursive: true });
  await symlink(sdkDirectory, join(f.release, 'node_modules/@anthropic-ai/claude-agent-sdk'));
  const lock = join(f.release, 'node_modules/.pnpm/lock.yaml');
  await writeFile(lock, "packages:\n  '@anthropic-ai/claude-agent-sdk@0.3.284':\n    resolution: {integrity: sha512-aGVsbG8=}\n");
  await copyFile('/usr/bin/true', join(f.bin, 'claude'));
  await chmod(join(f.bin, 'claude'), 0o700);
  await refreshWorkflowSelection(f.options);
  const selection = JSON.parse(await readFile(f.path, 'utf8'));
  assert.equal(selection.codexBinary, undefined);
  assert.deepEqual(selection.claude, { binary: join(f.bin, 'claude'), installedLockPath: lock,
    sdkEntrypoint: join(sdkDirectory, 'sdk.mjs') });
  const info = await stat(f.path);
  await nativeCodex(join(f.bin, 'codex'));
  await refreshWorkflowSelection({ ...f.options, environment: { PATH: '' } });
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')), selection);
  assert.equal((await stat(f.path)).ino, info.ino);
  await refreshWorkflowSelection(f.options);
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')), selection);
});

for (const defect of ['symlink', 'hardlink', 'public']) {
  test(`rejects a ${defect} selection without replacing or modifying its bytes`, async t => {
    const f = await fixture(t);
    await nativeCodex(join(f.bin, 'codex'));
    const outside = join(f.root, 'outside.json');
    const bytes = JSON.stringify({ schemaVersion: 1, codexBinary: '/retired/codex',
      expectedVersion: 'codex-cli 0.154.0', payloadPaths: [], appMcpLauncher: '/retired/launcher.mjs' });
    await writeFile(outside, bytes, { mode: 0o600 });
    if (defect === 'symlink') await symlink(outside, f.path);
    if (defect === 'hardlink') await link(outside, f.path);
    if (defect === 'public') await writeFile(f.path, bytes, { mode: 0o644 });
    await assert.rejects(refreshWorkflowSelection(f.options), { code: 'WORKER_WORKFLOW_UNAVAILABLE' });
    assert.equal(await readFile(f.path, 'utf8'), bytes);
    assert.equal(await readFile(outside, 'utf8'), bytes);
  });
}

test('lost Worker ownership prevents selection publication', async t => {
  const f = await fixture(t);
  await assert.rejects(refreshWorkflowSelection({ ...f.options,
    assertStateOwnership: () => { throw new Error('Worker ownership lost'); } }), /Worker ownership lost/);
  await assert.rejects(readFile(f.path), { code: 'ENOENT' });
});
