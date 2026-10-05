import { persistentFixtureRoot } from './fixtureStorage.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { buildCiRuntimeContext } from '../../../scripts/build-ci-runtime-context.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(persistentFixtureRoot, 'ci-image-context-')), repository = join(root, 'repo'), output = join(root, 'context');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(repository);
  const git = (...args) => execFileSync('git', args, { cwd: repository, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  git('init', '-q');
  for (const [path, bytes] of [['package.json', '{"packageManager":"pnpm@11.27.0"}'], ['apps/web/package.json', '{"name":"web"}'],
    ['pnpm-lock.yaml', 'lockfileVersion: 9\n'], ['pnpm-workspace.yaml', 'minimumReleaseAge: 2880\n'], ['.env', 'SECRET'], ['apps/web/local-cache', 'CACHE']]) {
    const full = join(repository, path); await mkdir(join(full, '..'), { recursive: true }); await writeFile(full, bytes);
  }
  const controls = join(repository, 'apps/worker/artifacts/ci-runtime'); await mkdir(controls, { recursive: true });
  for (const name of ['Containerfile', 'corepack']) await writeFile(join(controls, name), await readFile(new URL(`../artifacts/ci-runtime/${name}`, import.meta.url)));
  const commit = () => { git('add', '.'); git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  return { root, repository, output, git, commit, captured: commit() };
}

test('CI context captures committed manifests and policy without working bytes, credentials or caches', async t => {
  const f = await fixture(t);
  await writeFile(join(f.repository, 'package.json'), 'DIRTY');
  const receipt = await buildCiRuntimeContext({ repository: f.repository, commit: f.captured, output: f.output });
  assert.equal(receipt.sourceCommit, f.captured);
  assert.equal(await readFile(join(f.output, 'source-lock/package.json'), 'utf8'), '{"packageManager":"pnpm@11.27.0"}');
  assert.equal(receipt.files.length, 6);
  assert.ok(receipt.files.every(file => !file.path.includes('.env') && !file.path.includes('local-cache')));
  for (const file of receipt.files) {
    const bytes = execFileSync('git', ['show', `${f.captured}:${file.path}`], { cwd: f.repository });
    assert.equal(file.sha256, createHash('sha256').update(bytes).digest('hex'));
  }
  await assert.rejects(readFile(join(f.output, 'source-lock/.env')), { code: 'ENOENT' });
});

test('CI context rejects committed manifest symlinks before creating its output', async t => {
  const f = await fixture(t);
  await rm(join(f.repository, 'apps/web/package.json')); await symlink('../../.env', join(f.repository, 'apps/web/package.json'));
  const captured = f.commit();
  await assert.rejects(buildCiRuntimeContext({ repository: f.repository, commit: captured, output: f.output }), /regular committed/);
  await assert.rejects(readFile(join(f.output, 'context-receipt.json')), { code: 'ENOENT' });
});

test('CI context refuses to overwrite an existing directory', async t => {
  const f = await fixture(t); await mkdir(f.output); await writeFile(join(f.output, 'keep'), 'original');
  await assert.rejects(buildCiRuntimeContext({ repository: f.repository, commit: f.captured, output: f.output }), { code: 'EEXIST' });
  assert.equal(await readFile(join(f.output, 'keep'), 'utf8'), 'original');
});
