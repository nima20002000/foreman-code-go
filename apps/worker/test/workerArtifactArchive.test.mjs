import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, readdir, rm, lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { downloadWorkerArtifact, fetchGitHubAsset } from '../src/update.mjs';
import { persistentFixtureRoot } from './fixtureStorage.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const facts = { os: 'ubuntu', osRelease: '24.04', arch: 'x64', libc: 'glibc-2.39', node: 'v22.23.2',
  rootPersistent: true, homePersistent: true, storagePersistent: true };

function tarEntry(path, bytes, type = '0', declaredSize = bytes.length) {
  const header = Buffer.alloc(512);
  header.write(path);
  header.write('0000600\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${declaredSize.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.fill(32, 148, 156);
  header.write(type, 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  const checksum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
  return Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]);
}

async function fixture(t) {
  const base = await mkdtemp(join(persistentFixtureRoot, 'worker-archive-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const bytes = Buffer.from('release payload');
  const { os, osRelease, arch, libc, node } = facts;
  const manifest = { format: 1, version: '1.2.0', commit: 'a'.repeat(40), lockfileSha256: 'b'.repeat(64),
    packageManager: 'pnpm@11.27.0', protocolVersion: 1, identityFormat: 1,
    target: { os, osRelease, arch, libc, node },
    files: [{ path: 'src/cli.mjs', size: bytes.length, sha256: hash(bytes) }] };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  const release = { version: manifest.version, manifest, manifestSha256: hash(manifestBytes),
    github: { repository: 'octo/site', tag: `worker-${'c'.repeat(40)}` } };
  const directory = join(base, 'candidate');
  const download = entries => downloadWorkerArtifact({ release, directory, facts,
    request: async () => { throw new Error('GitHub carrier must not request chunks'); },
    fetchAsset: async ({ destination, maxBytes }) => {
      assert.ok(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes < 2 * 1024 * 1024,
        'The carrier must receive a manifest-derived compressed byte limit');
      await writeFile(destination, gzipSync(Buffer.concat([
        tarEntry('manifest.json', manifestBytes), ...entries, Buffer.alloc(1024),
      ])));
    } });
  return { base, directory, bytes, manifest, release, download };
}

test('streams the announced files and keeps their authenticated manifest', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.download([tarEntry('src/cli.mjs', f.bytes)]), f.manifest);
  assert.deepEqual(await readFile(join(f.directory, f.manifest.files[0].path)), f.bytes);
  assert.equal(hash(await readFile(join(f.directory, 'manifest.json'))), f.release.manifestSha256);
});

for (const [label, entries, code] of [
  ['undeclared compressed member', bytes => [tarEntry('extra.bin', Buffer.alloc(2 * 1024 * 1024)),
    tarEntry('src/cli.mjs', bytes)], 'artifact_archive_invalid'],
  ['oversized declared member', () => [tarEntry('src/cli.mjs', Buffer.alloc(2 * 1024 * 1024))],
    'artifact_file_size_mismatch'],
  ['non-regular member', bytes => [tarEntry('extra-link', Buffer.alloc(0), '2'), tarEntry('src/cli.mjs', bytes)],
    'artifact_archive_invalid'],
  ['duplicate declared member', bytes => [tarEntry('src/cli.mjs', bytes), tarEntry('src/cli.mjs', bytes)],
    'artifact_archive_invalid'],
  ['escaping member', bytes => [tarEntry('../outside.bin', Buffer.from('outside')), tarEntry('src/cli.mjs', bytes)],
    'artifact_archive_invalid'],
]) {
  test(`rejects ${label} before retaining an installation`, async t => {
    const f = await fixture(t);
    await assert.rejects(f.download(entries(f.bytes)), { code });
    assert.equal(await lstat(f.directory).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    }), null);
    assert.deepEqual(await readdir(f.base), []);
    await writeFile(join(f.base, 'update-status.json'), JSON.stringify({ state: 'failed' }));
    assert.deepEqual(JSON.parse(await readFile(join(f.base, 'update-status.json'), 'utf8')), { state: 'failed' });
  });
}

test('rejects an oversized compressed carrier before opening its archive', async t => {
  const f = await fixture(t);
  await assert.rejects(downloadWorkerArtifact({ release: f.release, directory: f.directory, facts,
    fetchAsset: async ({ destination, maxBytes }) => {
      assert.ok(Number.isSafeInteger(maxBytes));
      await writeFile(destination, Buffer.alloc(maxBytes + 1));
    } }), { code: 'artifact_archive_size_mismatch' });
  assert.deepEqual(await readdir(f.base), []);
});

test('the GitHub downloader caps streamed stdout before writing an oversized asset', async t => {
  const f = await fixture(t);
  const binaries = join(f.base, 'bin');
  await mkdir(binaries, { mode: 0o700 });
  await writeFile(join(binaries, 'gh'), `#!/usr/bin/env node
const { writeFile } = require('node:fs/promises');
const destination = process.argv[process.argv.indexOf('--output') + 1];
const bytes = Buffer.alloc(2 * 1024 * 1024);
if (destination === '-') {
  process.stdout.write(bytes);
} else {
  writeFile(destination, bytes).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
`, { mode: 0o700 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${binaries}:${previousPath ?? ''}`;
  const destination = join(f.base, 'download.tar.gz');
  try {
    await assert.rejects(fetchGitHubAsset({ github: f.release.github, asset: 'fixture.tar.gz',
      destination, maxBytes: 1024, signal: AbortSignal.timeout(5000) }),
    { code: 'artifact_archive_size_mismatch' });
    assert.equal(await lstat(destination).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    }), null);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});
