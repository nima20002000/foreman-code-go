import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { RUN_INSPECTION_TOOLS, RunRecordDetailSchema } from '@foreman-code/contracts/wave25'
import { scenarioFixture } from './helpers/eng07BScenarios.js'
import { runPath, scenarioHarness } from './helpers/eng07BHarness.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { DomainError } from '../src/modules/errors.js'

describe.skipIf(!postgresEnabled)('routing workflow cleanup', () => {
  it.each(['immediate', 'deferred'] as const)(
    'retries a database timeout after %s native closure without replaying native work', async closure => {
    const scenario = scenarioFixture('S3-03', randomUUID())
    const f = await scenarioHarness(scenario)
    const finishCleanup = f.base.runs.finishCleanup.bind(f.base.runs)
    const timeout = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })
    const cleanup = vi.spyOn(f.base.runs, 'finishCleanup')
      .mockRejectedValueOnce(timeout)
      .mockImplementation(finishCleanup)
    const closeReviewers = f.base.native.finishIdleReviewers.bind(f.base.native)
    const reviewers = vi.spyOn(f.base.native, 'finishIdleReviewers').mockImplementation(closeReviewers)
    if (closure === 'deferred') {
      const pending = new DomainError('REPEAT_CLEANUP_PENDING', 'Native closure is still pending.', 409)
      reviewers.mockRejectedValueOnce(pending).mockRejectedValueOnce(pending).mockRejectedValueOnce(pending)
    }
    try {
      const { saved } = await f.save('mcp')
      const started = await f.start('mcp', saved)
      const record = await f.settled(started.scope)
      expect(record).toMatchObject({
        run: { executionState: 'completed', outcome: 'succeeded' },
        cleanupPending: false,
        stopRequested: false,
      })
      expect(await f.readParity(`${runPath(started.scope)}/record`, RUN_INSPECTION_TOOLS.record, {
        workspaceId: started.scope.workspaceId,
        runId: started.scope.runId,
      })).toEqual(record)
      const reader = await f.base.access.issue({
        name: 'Run cleanup reader',
        audience: 'operator',
        expiresAt: new Date(Date.now() + 600_000),
        grants: [{ actions: ['runs:read'], scope: { runIds: [started.scope.runId] } }],
      })
      const monitor = await f.connect(reader.token)
      const denied = await monitor.callTool({
        name: 'run_start',
        arguments: { ...started.input, commandId: randomUUID() },
      })
      expect(denied.isError).toBe(true)
      expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
      const monitorRecord = RunRecordDetailSchema.parse(await f.mcp(RUN_INSPECTION_TOOLS.record, {
        workspaceId: started.scope.workspaceId,
        runId: started.scope.runId,
      }, monitor))
      const expectedMonitorRecord = structuredClone(record)
      delete expectedMonitorRecord.run.executionLocation
      expect(monitorRecord).toEqual(expectedMonitorRecord)
      expect(monitorRecord.run).not.toHaveProperty('executionLocation')
      expect(record.run.executionLocation).toBeDefined()
      expect(await f.http('GET', `${runPath(started.scope)}/record`, undefined, reader.token))
        .toEqual(monitorRecord)
      expect(await f.readParity(`${runPath(started.scope)}/record`, RUN_INSPECTION_TOOLS.record, {
        workspaceId: started.scope.workspaceId,
        runId: started.scope.runId,
      })).toEqual(record)
      const expectedNodes = scenario.executedIndexes.map(index => scenario.nodes[index]!.id)
      expect([...f.base.provider.startedNodes].sort()).toEqual(expectedNodes.sort())
      expect(new Set(f.base.provider.startedExecutions).size).toBe(expectedNodes.length)
      expect(f.base.provider.counts.starts).toBe(expectedNodes.length)
      expect(f.base.dispatchErrors).toEqual([])
    } finally {
      reviewers.mockRestore()
      cleanup.mockRestore()
      await f.close()
    }
  }, 120_000)
})
