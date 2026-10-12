import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { SavedRunDetailsSchema } from '@foreman-code/contracts/wave25'
import { installationUpdateFixture, startWhenReady, completedRun } from './helpers/harnessInstallationUpdate.js'
import { readUntil } from './helpers/observableCondition.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'

describe('installed Main-local workflows across systemd restart', () => {
  for (const phase of ['active', 'admitting interval', 'failed admission'] as const) {
    const behavior = phase === 'failed admission'
      ? 'closes interrupted processes when interval admission fails during restart'
      : `reattaches graph work and its ${phase} check, then closes their processes`
    it(behavior, async () => {
      const fixture = await installationUpdateFixture({ workflow: 'interval', executionHost: 'main',
        installedMainService: true })
      const service = fixture.mainService!
      let restart: Promise<unknown> | undefined
      try {
        await fixture.provider.blockWorkflowTurns({ allowFirst: 1 })
        if (phase !== 'active') await fixture.provider.blockWorkflowAdmission()
        const started = (await startWhenReady(fixture))!
        const before = await readUntil(async () => {
          const details = await fixture.details(started.run.id)
          const calls = await fixture.provider.calls()
          const active = details.executions.filter(item => item.state === 'running' && item.nativeSessionId)
          const blocked = calls.some(call => call.workflowAdmissionBlocked)
          const turns = calls.filter(call => call.workflowTurn)
          return active.length === 2 && (phase === 'active' ? turns.length === 3 : blocked) ? details : undefined
        }, value => value !== undefined, { timeoutMs: 180_000, description: 'graph work and interval session' })
        if (!before) throw new Error('Expected two saved active native sessions.')
        const active = before.executions.filter(item => item.state === 'running')
        const launches = service.registry.snapshot().launches.filter(launch =>
          active.some(item => launch.owner === `execution:${item.id}`) && launch.lifecycle !== 'closed')
        expect(launches).toHaveLength(2)
        const reader = await fixture.access.issue({ name: 'Installed restart reader', audience: 'operator',
          expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ['runs:read'],
            scope: { workspaceIds: [started.run.workspaceId], workflowIds: [started.run.workflowId] } }] })
        restart = service.restart()
        if (phase !== 'active') {
          await readUntil(service.state, value => value === 'deactivating',
          { timeoutMs: 10_000, description: 'systemd beginning API restart' })
          await service.waitForPreservation()
          if (phase === 'failed admission') await fixture.provider.failWorkflowAdmission()
          await fixture.provider.releaseWorkflowAdmission()
        }
        await restart
        await fixture.reconcile()
        await expectMcpAccessDenied(fixture.call('run_stop', { workspaceId: started.run.workspaceId,
          runId: started.run.id, commandId: randomUUID() }, reader.token))
        const recovered = SavedRunDetailsSchema.parse(decodeMcpToolResult(await fixture.call('run_get', {
          detail: 'full', workspaceId: started.run.workspaceId, runId: started.run.id,
        }, reader.token)))
        if (phase !== 'failed admission') {
          expect(recovered.run.executionState).toBe('running')
          for (const original of active) {
            expect(recovered.executions.find(item => item.id === original.id)).toMatchObject({
              state: 'running', attempt: original.attempt, nativeSessionId: original.nativeSessionId,
            })
          }
          await fixture.provider.releaseWorkflowTurns()
        }
        const finished = phase === 'failed admission'
          ? await readUntil(async () => {
            await fixture.reconcile()
            return fixture.details(started.run.id)
          },
            details => details.run.executionState === 'completed',
            { timeoutMs: 90_000, description: 'interrupted run settlement' })
          : await completedRun(fixture, started.run.id)
        expect(finished.run.outcome).toBe(phase === 'failed admission' ? 'failed' : 'succeeded')
        if (phase === 'failed admission') {
          expect(finished.executions.some(item => active.some(original => original.id === item.id)
            && item.result?.error?.code === 'EXECUTION_INTERRUPTED')).toBe(true)
        }
        for (const original of active) {
          expect(finished.executions.find(item => item.id === original.id)).toMatchObject({
            state: 'completed', attempt: original.attempt, nativeSessionId: original.nativeSessionId,
            result: { outcome: phase === 'failed admission' ? 'failed' : 'succeeded' },
          })
        }
        const calls = await fixture.provider.calls()
        for (const original of active) {
          if (phase !== 'failed admission') {
            expect(calls.filter(call => call.method === 'turn/start'
              && call.correlationId === `execution:${original.id}`)).toHaveLength(1)
          }
        }
        await readUntil(async () => service.registry.snapshot().launches, values => launches.every(original =>
          values.find(item => item.launchId === original.launchId)?.lifecycle === 'closed'),
        { timeoutMs: 10_000, description: 'reattached native process cleanup' })
        for (const original of launches) {
          if (original.provider) expect(() => process.kill(original.provider!.pid, 0)).toThrow()
        }
      } finally {
        try {
          await fixture.provider.releaseWorkflowAdmission()
          await fixture.provider.releaseWorkflowTurns()
          await restart
        } finally { await fixture.close() }
      }
    }, 360_000)
  }
})
