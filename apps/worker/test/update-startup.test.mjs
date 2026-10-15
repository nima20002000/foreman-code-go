import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { superviseWorkerUpdate } from '../src/updateSupervisor.mjs';

// Readiness has its own budget when smoke runs after the new process is ready.
test('update supervision gives process startup sixty seconds before separate CI smoke', async t => {
  const fixtureRoot = join(homedir(), '.cache', 'foreman-tmp');
  await mkdir(fixtureRoot, { recursive: true });
  const root = await mkdtemp(join(fixtureRoot, 'worker-startup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'versions'));
  const record = { format: 1, status: { state: 'restarting', currentVersion: '1.0.0', targetVersion: '1.1.0',
    manifestSha256: 'a'.repeat(64) }, manifestSha256: 'b'.repeat(64), restart: {
    service: 'graphql-worker.service', root, stateDirectory: root,
    pointer: { kind: 'file', path: join(root, 'release') }, directory: join(root, 'incoming'),
    previousDirectory: join(root, 'previous'), previousVersion: '1.0.0',
    workerInstallationId: '11111111-1111-4111-8111-111111111111', requestId: 'update-request',
    ciSmoke: { repository: 'fixture/project', commit: 'c'.repeat(40) },
  } };
  const phases = [];
  await superviseWorkerUpdate(record, {
    prepareService: async () => {}, switchPointer: async () => {}, restart: async () => {},
    persist: async () => {},
    ready: async options => {
      if (options.version === '1.1.0') assert.equal(options.timeoutMs, 60_000);
      phases.push('ready');
    },
    smoke: async () => { phases.push('smoke'); },
  });
  assert.equal(record.status.state, 'current');
  assert.deepEqual(phases, ['ready', 'smoke']);
});
