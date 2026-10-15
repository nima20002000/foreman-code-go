import test from 'node:test';
import assert from 'node:assert/strict';
import { CiHostRequestSchema } from '@foreman-code/contracts';
import { runCiInstallSmoke } from '../src/ciInstallSmoke.mjs';

test('update smoke waits for busy capacity and uses a valid focused integration start', async () => {
  const requests = [];
  let starts = 0;
  const runner = { handle: async request => {
    requests.push(request);
    if (request.operation === 'status') return { ready: true, cpuCount: 8, memoryBytes: 16 * 2 ** 30 };
    if (request.operation === 'start') {
      CiHostRequestSchema.parse(request);
      if (++starts < 3) throw Object.assign(new Error('Existing CI is still running.'), { code: 'CI_HOST_BUSY' });
      assert.equal(request.scope, 'affected');
      assert.equal(request.gate, undefined);
      return {};
    }
    if (request.operation === 'cancel') return {};
    return { run: { state: 'passed', exitCode: 0 }, text: '', testResults: {
      summary: { passed: 1, failed: 0 }, files: [{ file: 'apps/api/test/ci-smoke.integration.test.ts',
        tests: [{ status: 'passed' }] }] } };
  } };
  await runCiInstallSmoke({ repository: 'fixture/project', commit: 'a'.repeat(40) },
    { runner, timeoutMs: 50, capacityTimeoutMs: 100, pollMs: 1 });
  assert.equal(starts, 3);
  assert.equal(new Set(requests.filter(request => request.operation === 'start').map(request => request.runId)).size, 1);
  assert.equal(requests.some(request => request.operation === 'cancel'), false);
});

test('update smoke bounds busy capacity waits and cancels its own ticket', async () => {
  let canceled = false;
  const runner = { handle: async request => {
    if (request.operation === 'status') return { ready: true, cpuCount: 8, memoryBytes: 16 * 2 ** 30 };
    if (request.operation === 'cancel') { canceled = true; return {}; }
    throw Object.assign(new Error('Existing CI is still running.'), { code: 'CI_HOST_BUSY' });
  } };
  await assert.rejects(runCiInstallSmoke({ repository: 'fixture/project', commit: 'a'.repeat(40) },
    { runner, timeoutMs: 50, capacityTimeoutMs: 10, pollMs: 1 }), /capacity wait timed out/);
  assert.equal(canceled, true);
});

for (const { capacity, cpuCount, memoryGiB } of [
  { capacity: 'normal', cpuCount: 16, memoryGiB: 14 },
  { capacity: 'CPU-limited', cpuCount: 8, memoryGiB: 32 },
  { capacity: 'memory-limited', cpuCount: 16, memoryGiB: 4 },
]) {
  for (const outcome of ['passed', 'failed', 'no-tests', 'timeout']) {
    test(`Worker install CI smoke uses ${capacity} setup and handles ${outcome}`, async () => {
      const requests = [];
      const runner = { handle: async request => {
        requests.push(request);
        if (request.operation === 'status') return { ready: true, cpuCount, memoryBytes: memoryGiB * 2 ** 30 };
        if (request.operation === 'start') CiHostRequestSchema.parse(request);
        if (request.operation !== 'read') return {};
        if (outcome === 'timeout') return new Promise(() => {});
        return { run: { state: outcome === 'failed' ? 'failed' : 'passed', exitCode: outcome === 'failed' ? 1 : 0,
          message: outcome === 'failed' ? 'ERR_PNPM_NO_OFFLINE_META' : null }, text: 'setup log',
          ...(outcome === 'no-tests' ? {} : { testResults: { summary: { passed: 1, failed: 0 }, files: [{
            file: 'apps/api/test/ci-smoke.integration.test.ts', tests: [{ status: 'passed' }] }] } }) };
      } };
      const smoke = runCiInstallSmoke({ repository: 'octo/project', commit: 'a'.repeat(40) },
        { runner, timeoutMs: 100, pollMs: 5 });
      if (outcome === 'passed') await smoke;
      else {
        const failures = { failed: /ERR_PNPM_NO_OFFLINE_META/, timeout: /timed out/, 'no-tests': /without running/ };
        await assert.rejects(smoke, failures[outcome]);
      }
      const start = requests.find(request => request.operation === 'start');
      assert.equal(start.suite, 'integration');
      assert.equal(start.scope, 'affected');
      assert.equal(start.gate, undefined);
      assert.equal(start.integrationShards, undefined);
      assert.deepEqual(start.files, ['apps/api/test/ci-smoke.integration.test.ts']);
      assert.equal(requests.some(request => request.operation === 'cancel'), outcome !== 'passed');
    });
  }
}

for (const enabled of [false, true]) {
  test(`Worker startup requests its authenticated smoke configuration, enabled=${enabled}`, async () => {
    const { runWorkerStartupSmoke } = await import('../src/ciInstallSmoke.mjs');
    const operations = [];
    const configuration = { repository: 'octo/project', commit: 'a'.repeat(40) };
    let ran;
    await runWorkerStartupSmoke({ manifestSha256: 'b'.repeat(64), request: async payload => {
      operations.push(payload);
      return { payload: { operation: 'ci-smoke', ciSmoke: enabled ? configuration : null } };
    }, smoke: async value => { ran = value; } });
    assert.deepEqual(operations, [{ operation: 'ci-smoke', manifestSha256: 'b'.repeat(64) }]);
    assert.deepEqual(ran, enabled ? configuration : undefined);
  });
}

test('Worker readiness waits for first-upgrade CI smoke and exposes its original failure', async () => {
  const { workerCiStartupStatus } = await import('../src/ciInstallSmoke.mjs');
  const connected = { phase: 'ready', failure: null };
  assert.equal(workerCiStartupStatus(connected, { pending: true, error: null }).phase, 'synchronizing');
  const failed = workerCiStartupStatus(connected, { pending: true, error: 'ERR_PNPM_NO_OFFLINE_META' });
  assert.equal(failed.phase, 'blocked');
  assert.equal(failed.failure, 'ERR_PNPM_NO_OFFLINE_META');
  assert.deepEqual(workerCiStartupStatus(connected, { pending: false, error: null }), connected);
})


test('a single-file update smoke can start alongside unrelated CI when a slot is free', async () => {
  let started = false;
  const runner = { handle: async request => {
    if (request.operation === 'status') return { ready: true, cpuCount: 16, memoryBytes: 32 * 2 ** 30 };
    if (request.operation === 'start') {
      CiHostRequestSchema.parse(request);
      if (request.gate) throw Object.assign(new Error('Another CI job is active.'), { code: 'CI_HOST_BUSY' });
      started = true;
      return {};
    }
    if (request.operation === 'cancel') return {};
    return { run: { state: 'passed', exitCode: 0 }, text: '', testResults: {
      summary: { passed: 1, failed: 0 }, files: [{ file: 'apps/api/test/ci-smoke.integration.test.ts',
        tests: [{ status: 'passed' }] }] } };
  } };
  await runCiInstallSmoke({ repository: 'fixture/project', commit: 'a'.repeat(40) },
    { runner, timeoutMs: 100, capacityTimeoutMs: 50, pollMs: 1 });
  assert.equal(started, true);
});
