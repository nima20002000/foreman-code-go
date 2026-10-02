import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { workerPath } from '../src/harnessPath.mjs';

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'worker-harness-path-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}
async function nvm(home, version = 'v22.17.1') {
  const root = join(home, '.nvm/versions/node', version);
  const payload = join(root, 'lib/node_modules/@openai/codex/bin/codex.js');
  await mkdir(dirname(payload), { recursive: true });
  await mkdir(join(root, 'bin'));
  await writeFile(payload, '#!/usr/bin/env node\nconsole.log(process.version);', { mode: 0o775 });
  await symlink('../lib/node_modules/@openai/codex/bin/codex.js', join(root, 'bin/codex'));
  return { root, bin: join(root, 'bin'), payload };
}

test('discovers existing NVM npm symlinks while their env shebang uses pinned Node first', async (t) => {
  const home = await fixture(t), install = await nvm(home);
  await chmod(join(home, '.nvm'), 0o775);
  const path = workerPath(home, process.execPath);
  assert.equal(path.split(':')[0], dirname(process.execPath));
  assert.ok(path.split(':').includes(install.bin));
  const probe = spawnSync(join(install.bin, 'codex'), ['--version'], { env: { HOME: home, PATH: path }, cwd: home, encoding: 'utf8', timeout: 5000 });
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stdout.trim(), process.version);
});

test('missing executables and inherited empty, relative and arbitrary absolute PATH entries do not extend discovery', async (t) => {
  const home = await fixture(t), bin = join(home, '.local/bin');
  await mkdir(bin, { recursive: true });
  const previous = process.env.PATH;
  t.after(() => { process.env.PATH = previous; });
  process.env.PATH = `:.:relative:${home}/untrusted`;
  assert.equal(workerPath(home, process.execPath), [...new Set([dirname(process.execPath), '/usr/bin', '/bin'])].join(':'));
  assert.equal(workerPath('relative/home', process.execPath), workerPath('/missing/home', process.execPath));
});

test('rejects world-writable installs, nonregular launchers and symlinks escaping home', async (t) => {
  const home = await fixture(t), install = await nvm(home);
  await chmod(install.payload, 0o777);
  assert.ok(!workerPath(home, process.execPath).split(':').includes(install.bin));
  await chmod(install.payload, 0o775);
  await chmod(join(home, '.nvm'), 0o777);
  assert.ok(!workerPath(home, process.execPath).split(':').includes(install.bin));
  const local = join(home, '.local/bin');
  await mkdir(join(local, 'codex'), { recursive: true });
  await symlink(process.execPath, join(local, 'opencode'));
  assert.ok(!workerPath(home, process.execPath).split(':').includes(local));
});

test('discovers host-local OpenCode without admitting symlinked installation directories', async (t) => {
  const home = await fixture(t), bin = join(home, '.opencode/bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'opencode'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  assert.ok(workerPath(home, process.execPath).split(':').includes(bin));
  await mkdir(join(home, '.local'));
  await symlink(bin, join(home, '.local/bin'));
  assert.ok(!workerPath(home, process.execPath).split(':').includes(join(home, '.local/bin')));
});
