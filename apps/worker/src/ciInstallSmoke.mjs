import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { gateIntegrationShards } from '../../../apps/api/src/modules/ci-host/capacity.ts';

export async function runCiInstallSmoke({ repository, commit }, { runner,
  timeoutMs = 160_000, pollMs = 1000 } = {}) {
  const runId = randomUUID();
  const controller = new AbortController();
  const deadline = controller.signal;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const expired = new Promise((_, reject) => {
    deadline.addEventListener('abort', () => reject(new Error('Worker CI smoke timed out.')), { once: true });
  });
  const bounded = work => Promise.race([work, expired]);
  try {
    const status = await bounded(runner.handle({ operation: 'status' }));
    if (!status.ready) throw new Error(`Worker CI smoke setup: ${status.reasons.join('; ')}`);
    const integrationShards = gateIntegrationShards(status.cpuCount, Math.floor(status.memoryBytes * 0.9));
    await bounded(runner.handle({ operation: 'start', runId, repository, commit, suite: 'integration', gate: true, integrationShards, scope: 'affected', files: ['apps/api/test/ci-smoke.integration.test.ts'] }));
    while (true) {
      const reply = await bounded(runner.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 8192, testResults: true }));
      if (reply.run.state === 'passed' && reply.run.exitCode === 0) {
        const file = reply.testResults?.files.find(file => file.file === 'apps/api/test/ci-smoke.integration.test.ts');
        if (!file?.tests.some(test => test.status === 'passed') || reply.testResults.summary.failed !== 0) {
          throw new Error(`Worker CI smoke ${runId} passed without running the smoke test.`);
        }
        return;
      }
      if (['failed', 'lost', 'canceled'].includes(reply.run.state)) {
        throw new Error(`Worker CI smoke ${runId}: ${reply.run.message ?? reply.run.state}\n${reply.text}`);
      }
      await delay(pollMs, undefined, { signal: deadline });
    }
  } catch (error) {
    const cancellation = runner.handle({ operation: 'cancel', runId });
    await Promise.race([cancellation.catch(failure => {
      process.stderr.write(`Worker CI smoke cancellation failed: ${failure.message}\n`);
    }), delay(5000)]);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
