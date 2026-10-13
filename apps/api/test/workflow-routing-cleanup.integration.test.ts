import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { RUN_INSPECTION_TOOLS } from '@foreman-code/contracts/wave25'
import { scenarioFixture } from './helpers/eng07BScenarios.js'
import { runPath, scenarioHarness } from './helpers/eng07BHarness.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'

describe.skipIf(!postgresEnabled)('routing workflow cleanup', () => {
  it('retries a database timeout after completion without replaying native work', async () => {
    const scenario = scenarioFixture('S3-03', randomUUID())
    const f = await scenarioHarness(scenario)
    const finishCleanup = f.base.runs.finishCleanup.bind(f.base.runs)
    const timeout = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })
    const cleanup = vi.spyOn(f.base.runs, 'finishCleanup')
      .mockRejectedValueOnce(timeout)
      .mockImplementation(finishCleanup)
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
      expect(await f.mcp(RUN_INSPECTION_TOOLS.record, {
        workspaceId: started.scope.workspaceId,
        runId: started.scope.runId,
      }, monitor)).toEqual(record)
      const expectedNodes = scenario.executedIndexes.map(index => scenario.nodes[index]!.id)
      expect([...f.base.provider.startedNodes].sort()).toEqual(expectedNodes.sort())
      expect(new Set(f.base.provider.startedExecutions).size).toBe(expectedNodes.length)
      expect(f.base.provider.counts.starts).toBe(expectedNodes.length)
      expect(f.base.dispatchErrors).toEqual([])
    } finally {
      cleanup.mockRestore()
      await f.close()
    }
  }, 120_000)
})
