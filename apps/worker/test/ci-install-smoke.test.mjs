import test from 'node:test';
import assert from 'node:assert/strict';
import { runCiInstallSmoke } from '../src/ciInstallSmoke.mjs';

for (const outcome of ['passed', 'failed', 'no-tests', 'timeout']) {
  test(`Worker install CI smoke uses normal setup and handles ${outcome}`, async () => {
    const requests = [];
    const runner = { handle: async request => {
      requests.push(request);
      if (request.operation === 'status') return { ready: true, cpuCount: 16, memoryBytes: 14 * 2 ** 30 };
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
    assert.equal(start.gate, true);
    assert.equal(start.integrationShards, 11);
    assert.deepEqual(start.files, ['apps/api/test/ci-smoke.integration.test.ts']);
    assert.equal(requests.some(request => request.operation === 'cancel'), outcome !== 'passed');
  });
}
