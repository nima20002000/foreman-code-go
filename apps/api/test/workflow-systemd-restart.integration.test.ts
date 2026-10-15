import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { SavedRunDetailsSchema } from '@foreman-code/contracts/wave25'
import { readUntil } from './helpers/observableCondition.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { DomainError } from '../src/modules/errors.js'
import { SourceError } from '../src/modules/sources/manifest.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'

describe('queued workflow preparation across engine restart', () => {
  it.each([
    new SourceError('SOURCE_MATERIALIZATION_UNCERTAIN', 'Source preparation was interrupted before activation.'),
    new DomainError('HARNESS_PROFILE_UNAVAILABLE', 'The saved native qualification is unavailable.', 409),
  ])('settles $code and exposes the persisted failure through authenticated MCP', async failure => {
    let preparationError: Error = new DomainError('DEVICE_HOST_UNAVAILABLE', 'Source host disconnected', 503)
    const fixture = await currentOperatorIntegration({ preparePlacementExecution: async () => {
      throw preparationError
    } })
    try {
      // An unavailable host is infrastructure, so every attempt that cannot prepare is recorded
      // as retryable and the node keeps starting fresh attempts instead of failing the Run.
      const started = fixture.engine.start(fixture.f.run.id).then(() => undefined, (error: unknown) => error)
      const before = (await readUntil(() => fixture.runs.getDetails(fixture.f.scope.workspaceId, fixture.f.run.id),
        details => (details?.executions.length ?? 0) >= 2,
        { timeoutMs: 30_000, description: 'a fresh attempt after unavailable preparation' }))!
      expect(before.run.executionState).not.toBe('completed')
      expect(before.executions[0]).toMatchObject({ state: 'completed', attempt: 1, result: {
        outcome: 'failed', error: { code: 'EXECUTION_PREPARATION_UNAVAILABLE', retryable: true } } })
      await fixture.engine.shutdown()
      await started
      preparationError = failure
      const restarted = fixture.compose()
      await restarted.engine.reconcile()
      const finished = await readUntil(() => fixture.runs.getDetails(fixture.f.scope.workspaceId, fixture.f.run.id),
        details => details?.run.executionState === 'completed',
        { timeoutMs: 30_000, description: 'queued preparation failure settlement after restart' })
      expect(finished!.run).toMatchObject({ outcome: 'failed', result: {
        outcome: 'failed', error: { code: failure.code, message: failure.message, retryable: false },
      } })
      expect(finished!.executions.length).toBeGreaterThanOrEqual(before.executions.length)
      expect(finished!.executions[0]).toMatchObject({ id: before.executions[0]!.id, state: 'completed', attempt: 1 })
      const reader = await fixture.access.issue({ name: 'Restart failure reader', audience: 'operator',
        expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ['runs:read'],
          scope: { workspaceIds: [fixture.f.scope.workspaceId], workflowIds: [fixture.f.scope.workflowId] } }] })
      const client = await fixture.connect(reader.token)
      await expectMcpAccessDenied(client.callTool({ name: 'run_stop', arguments: {
        workspaceId: fixture.f.scope.workspaceId, runId: fixture.f.run.id, commandId: randomUUID(),
      } }))
      const persisted = SavedRunDetailsSchema.parse(decodeMcpToolResult(await client.callTool({ name: 'run_get',
        arguments: { detail: 'full', workspaceId: fixture.f.scope.workspaceId, runId: fixture.f.run.id } })))
      const expectedRun = { ...finished!.run }
      delete expectedRun.authorizationPrincipalId
      delete expectedRun.executionLocation
      expect(persisted.run).toEqual(expectedRun)
      expect(persisted.executions).toEqual(finished!.executions)
    } finally { await fixture.close() }
  }, 60_000)
})
