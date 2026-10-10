import { expect } from 'vitest'
import { buildApp } from '../../src/app.js'
import type { OperatorServices } from '../../src/mcp/operator/types.js'
import { readCurrentRunDetails } from '../../src/modules/runs/currentRead.js'
import { RunGraphReadService } from '../../src/modules/run-graph/readService.js'
import { graphHeaders, graphRpc, graphRpcValue } from '../eng04-graph-composition-fixture.js'
import type { workflowSettlementFixture } from './workflowSettlementFixture.js'

export async function assertWorkflowFailureReadback(f: Awaited<ReturnType<typeof workflowSettlementFixture>>,
  code: string) {
  const runs: Pick<OperatorServices['runs'], 'get'> = {
    get: (principal, workspaceId, runId) => readCurrentRunDetails(f.db.pool, principal, workspaceId, runId),
  }
  // This read-only fixture composes only the services exercised by run_get and its HTTP route.
  const app = buildApp({ readiness: { database: { ping: async () => undefined },
    checkpoints: { ping: async () => undefined } }, operator: { access: f.access, services: {
    commands: f.commands,
    runs,
    runGraph: new RunGraphReadService(f.db.pool, { qualifiedReads: true }),
  } as unknown as OperatorServices } })
  const args = { workspaceId: f.run.workspaceId, runId: f.run.id }
  const url = `/api/management/workspaces/${f.run.workspaceId}/runs/${f.run.id}`
  try {
    await app.ready()
    const http = await app.inject({ method: 'GET', url, headers: graphHeaders(f.writer.token) })
    expect(http.statusCode, http.body).toBe(200)
    expect(http.json()).toMatchObject({ run: { executionState: 'completed', outcome: 'failed',
      result: { error: { code, retryable: false } } }, cleanupPending: false })
    const mcp = await graphRpc(app, f.writer.token, 'tools/call', { name: 'run_get', arguments: { ...args, detail: 'full' } })
    expect(mcp.result?.isError).not.toBe(true)
    expect(graphRpcValue(mcp.result)).toEqual(http.json())
    const denied = await f.credential([{ actions: ['runs:read'],
      scope: { workspaceIds: [f.run.workspaceId], workflowIds: ['another-workflow'] } }])
    const blocked = await graphRpc(app, denied.token, 'tools/call', { name: 'run_get', arguments: { ...args, detail: 'full' } })
    expect(blocked.result?.isError).toBe(true)
    expect(JSON.stringify(blocked.result)).toContain('ACCESS_DENIED')
    expect((await app.inject({ method: 'GET', url, headers: graphHeaders(denied.token) })).statusCode).toBe(403)
  } finally {
    await app.close()
  }
}
