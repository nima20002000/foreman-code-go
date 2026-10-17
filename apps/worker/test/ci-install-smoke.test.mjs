import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { CiHostRequestSchema } from '@foreman-code/contracts';
import { runCiInstallSmoke } from '../src/ciInstallSmoke.mjs';
const require = createRequire(new URL('../../api/package.json', import.meta.url));
const { tsImport } = await import(require.resolve('tsx/esm/api'));
const { HostCiRunner, systemHostCiPorts } = await tsImport('../../api/src/modules/ci-host/runner.ts', import.meta.url);

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


test('a single-file update smoke can start alongside unrelated CI when a slot is free', async t => {
  const root = await mkdtemp(join(homedir(), '.cache', 'foreman-tmp', 'install-smoke-'));
  const origin = join(root, 'origin');
  await mkdir(origin);
  await writeFile(join(origin, 'package.json'), JSON.stringify({ foremanCi: { hostSlots: 1 },
    scripts: { lint: 'fixture', integration: 'fixture' } }));
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_COMMITTER_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = (...args) => execFileSync('git', args, { cwd: origin, env, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  const commit = git('rev-parse', 'HEAD');
  const occupied = randomUUID();
  const units = new Set();
  const launched = [];
  const system = systemHostCiPorts();
  // GitHub authentication and the systemd job executor are the external boundaries.
  const ports = { ...system, cpus: 16, memoryBytes: 32 * 2 ** 30,
    availableMemoryBytes: () => 32 * 2 ** 30, run: async (file, args, options) => {
      if (file === 'gh') return { code: 0, stdout: '', stderr: '' };
      if (file === 'git') return system.run(file,
        args.map(arg => arg.startsWith('https://github.com/') ? origin : arg), options);
      if (file === 'systemd-run') {
        const unit = args.find(arg => arg.startsWith('--unit=')).slice(7);
        units.add(unit);
        const directory = dirname(args.at(-1));
        const runId = basename(directory);
        launched.push(runId);
        if (runId !== occupied) {
          await writeFile(join(directory, 'log'), 'smoke completed');
          await writeFile(join(directory, 'step'), 'integration');
          await writeFile(join(directory, 'test-results.json'), JSON.stringify({
            summary: { passed: 1, failed: 0, skipped: 0 }, truncated: false, files: [{
              file: 'apps/api/test/ci-smoke.integration.test.ts', status: 'passed', durationMs: 1,
              tests: [{ name: 'smoke', status: 'passed', durationMs: 1 }] }] }));
          await writeFile(join(directory, 'exit'), '0');
          units.delete(unit);
        }
        return { code: 0, stdout: '', stderr: '' };
      }
      if (file === 'systemctl') {
        if (args.includes('stop')) units.delete(args.at(-1).replace(/\.service$/, ''));
        const stdout = args.filter(arg => arg.endsWith('.service')).map(unit =>
          `Id=${unit}\nLoadState=loaded\nActiveState=${units.has(unit.replace(/\.service$/, '')) ? 'active' : 'inactive'}\n`).join('\n');
        return { code: 0, stdout, stderr: '' };
      }
      return system.run(file, args, options);
    } };
  const runner = new HostCiRunner(join(root, 'runner'), ports, env);
  t.after(async () => {
    try { await runner.beginDrain(); await runner.cancel(occupied); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  await runner.handle({ operation: 'start', runId: occupied, repository: 'fixture/project', commit,
    suite: 'lint', scope: 'full' });
  const busy = await runner.handle({ operation: 'status' });
  assert.equal(busy.slotsUsed, 1);
  assert.ok(busy.slotsTotal > 1);
  assert.equal(busy.runs.find(run => run.runId === occupied).state, 'running');
  await runCiInstallSmoke({ repository: 'fixture/project', commit },
    { runner, timeoutMs: 5000, capacityTimeoutMs: 5000, pollMs: 1 });
  assert.equal(launched.length, 2);
  const status = await runner.handle({ operation: 'status' });
  assert.equal(status.runs.find(run => run.runId === occupied).state, 'running');
  assert.equal(status.runs.find(run => run.runId === launched[1]).state, 'passed');
  await runner.cancel(occupied);
  const smoke = await runner.handle({ operation: 'read', runId: launched[1], afterOffset: 0, maxBytes: 8192,
    testResults: true });
  assert.equal(smoke.run.state, 'passed');
  assert.equal(smoke.testResults.summary.passed, 1);
});
