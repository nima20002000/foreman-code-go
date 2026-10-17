import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import * as packaging from '../../../scripts/worker-artifact-files.mjs';
import { persistentFixtureRoot } from './fixtureStorage.mjs';

const { Packr, Unpackr } = createRequire(import.meta.url)('msgpackr');

async function fixture(t) {
  const root = await mkdtemp(join(persistentFixtureRoot, 'claude-sdk-packaging-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const output = join(root, 'artifact');
  const store = join(root, 'store');
  await mkdir(store);
  const database = new DatabaseSync(join(store, 'index.db'));
  const lock = { importers: { 'apps/api': { dependencies: {
    '@anthropic-ai/claude-agent-sdk': { version: '0.3.284' },
  } } }, packages: {}, snapshots: {} };
  const sdk = '@anthropic-ai/claude-agent-sdk';
  const definitions = [
    { name: sdk, version: '0.3.284', dependencies: { dependency: '1.0.0', consumer: '1.0.0' },
      optionalDependencies: { foreign: '1.0.0' },
      code: "import {value} from 'dependency'; import {nested} from 'consumer'; export const result = [value, nested];" },
    { name: 'dependency', version: '1.0.0', code: 'export const value = 1;' },
    { name: 'consumer', version: '1.0.0', dependencies: { dependency: '2.0.0' },
      code: "import {value} from 'dependency'; export const nested = value;" },
    { name: 'dependency', version: '2.0.0', code: 'export const value = 2;' },
  ];
  const paths = new Map();
  try {
    database.exec('CREATE TABLE package_index (key TEXT PRIMARY KEY, data BLOB NOT NULL) WITHOUT ROWID');
    const insert = database.prepare('INSERT INTO package_index (key, data) VALUES (?, ?)');
    for (const entry of definitions) {
      const key = `${entry.name}@${entry.version}`;
      const path = join(source, 'installed', key, 'node_modules', entry.name);
      paths.set(key, path);
      await mkdir(path, { recursive: true });
      const files = new Map([
        ['package.json', Buffer.from(JSON.stringify({ name: entry.name, version: entry.version, type: 'module',
          main: 'sdk.mjs', dependencies: entry.dependencies, optionalDependencies: entry.optionalDependencies }))],
        ['sdk.mjs', Buffer.from(entry.code)], ['LICENSE', Buffer.from('license')],
      ]);
      for (const [name, bytes] of files) await writeFile(join(path, name), bytes);
      const integrity = `sha512-${createHash('sha512').update(key).digest('base64')}`;
      lock.packages[key] = { resolution: { integrity } };
      lock.snapshots[key] = { dependencies: entry.dependencies, optionalDependencies: entry.optionalDependencies };
      const index = { manifest: { name: entry.name, version: entry.version }, requiresBuild: false, algo: 'sha512',
        files: new Map([...files].map(([name, bytes]) => [name, {
          size: bytes.length, digest: createHash('sha512').update(bytes).digest('hex'),
        }])) };
      insert.run(`${integrity}\t${key}`, new Packr({ useRecords: true, moreTypes: true }).pack(index));
    }
  } finally { database.close(); }
  lock.packages['foreign@1.0.0'] = { os: ['darwin'], resolution: { integrity: 'unused' } };
  for (const entry of definitions) {
    const path = paths.get(`${entry.name}@${entry.version}`);
    for (const [name, version] of Object.entries(entry.dependencies ?? {})) {
      const destination = join(path, 'node_modules', name);
      await mkdir(dirname(destination), { recursive: true });
      await symlink(paths.get(`${name}@${version}`), destination);
    }
  }
  const installed = join(source, 'apps/api/node_modules', sdk);
  await mkdir(dirname(installed), { recursive: true });
  await symlink(paths.get(`${sdk}@0.3.284`), installed);
  return { root: source, output, store, lock, paths,
    decode: blob => new Unpackr({ useRecords: true, moreTypes: true }).unpack(blob) };
}

test('ships the locked Claude SDK dependency graph with version conflicts and integrity metadata', async t => {
  const f = await fixture(t);
  const packages = await packaging.copyClaudeSdkPackagesFromStore(f);
  assert.equal(packages.length, 4);
  assert.ok(packages.every(entry => /^sha512-/.test(entry.integrity) && /^[a-f0-9]{64}$/.test(entry.indexBlobSha256)));
  // Removing the source installation proves runtime resolution uses only artifact files.
  await rm(f.root, { recursive: true });
  const sdk = createRequire(join(f.output, 'package.json')).resolve('@anthropic-ai/claude-agent-sdk');
  assert.ok((await realpath(sdk)).startsWith(`${f.output}/`));
  assert.deepEqual((await import(pathToFileURL(sdk).href)).result, [1, 2]);
  const metadata = await readFile(join(f.output, 'artifacts/claude-sdk-lock.yaml'), 'utf8');
  assert.ok(metadata.includes(f.lock.packages['@anthropic-ai/claude-agent-sdk@0.3.284'].resolution.integrity));
  assert.ok((await packaging.artifactFiles(f.output)).some(file => file.path === 'artifacts/claude-sdk-lock.yaml'));
});

test('rejects a modified transitive SDK dependency rather than shipping unverified bytes', async t => {
  const f = await fixture(t);
  await writeFile(join(f.paths.get('dependency@2.0.0'), 'sdk.mjs'), 'export const value = 9;');
  await assert.rejects(packaging.copyClaudeSdkPackagesFromStore(f), /Package integrity mismatch/);
});

test('imports the repository-locked SDK from the standalone artifact with verified installed dependencies', async t => {
  const require = createRequire(import.meta.url);
  const { parse } = require('yaml');
  const root = new URL('../../../', import.meta.url).pathname;
  const lock = parse(await readFile(join(root, 'pnpm-lock.yaml'), 'utf8'));
  const { storeDir: store } = parse(await readFile(join(root, 'node_modules/.modules.yaml'), 'utf8'));
  const output = await mkdtemp(join(persistentFixtureRoot, 'installed-claude-sdk-artifact-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const packages = await packaging.copyClaudeSdkPackagesFromStore({ root, output, store, lock,
    decode: blob => new Unpackr({ useRecords: true, moreTypes: true }).unpack(blob) });
  assert.ok(packages.some(entry => entry.name === '@anthropic-ai/sdk'));
  assert.ok(packages.some(entry => entry.name === '@modelcontextprotocol/sdk'));
  assert.ok(packages.some(entry => entry.name === '@anthropic-ai/claude-agent-sdk-linux-x64'));
  const entrypoint = createRequire(join(output, 'package.json')).resolve('@anthropic-ai/claude-agent-sdk');
  assert.ok((await realpath(entrypoint)).startsWith(`${output}/`));
  const sdk = await import(pathToFileURL(entrypoint).href);
  assert.equal(typeof sdk.query, 'function');
});
