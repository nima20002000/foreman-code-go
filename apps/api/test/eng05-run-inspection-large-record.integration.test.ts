import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import {
  RUN_INSPECTION_TOOLS, RUN_INSPECTION_LIMITS, RunRecordDetailSchema, RunExecutionsPageSchema, WorkflowRunV3Schema, makeCurrentWorkflowFixture,
} from '@foreman-code/contracts/wave25'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { measureIntegrationPhase } from './helpers/integrationPhase.js'
import {
  requestScope, reader, parity, path, terminal, denied,
} from './helpers/runInspection.js'

describe.skipIf(!postgresEnabled)('PostgreSQL authenticated Run inspection: large-record', () => {
  it('discloses the exact Run-only record over HTTP/MCP when aggregate execution history exceeds 2 MiB', async () => {
    const fixture = makeCurrentWorkflowFixture(randomUUID(), 'parallel')
    // Four real executions each retain this input. No execution/receipt rows are
    // fabricated; each individual accepted input stays below the existing 4 MiB bound.
    fixture.run.input = { instruction: 'Retain the exact original Run input', payload: 'x'.repeat(768 * 1024) }
    const f = await measureIntegrationPhase('large-input-setup', () =>
      currentOperatorIntegration({ fixture, approvalNodeIds: [] }))
    try {
      const args = requestScope(f), name = RUN_INSPECTION_TOOLS.record
      const queued = RunRecordDetailSchema.parse(await parity(f, f.client, f.writer.token, name, args))
      expect(queued.run.executionState).toBe('queued')
      expect(queued.run).not.toHaveProperty('result')
      await measureIntegrationPhase('large-input-execution', () => f.engine.start(f.f.run.id))
      await terminal(f)
      const executions = RunExecutionsPageSchema.parse(await parity(f, f.client, f.writer.token,
        RUN_INSPECTION_TOOLS.executions, { ...args, limit: 100 }))
      expect(executions.items).toHaveLength(fixture.version.definition.nodes.length)
      expect(executions.items.every(execution => execution.state === 'completed')).toBe(true)
      expect(executions.pageInfo.nextCursor).toBeNull()
      const counts = { ...f.provider.counts }
      const aggregate = await measureIntegrationPhase('large-input-aggregate-read', () => f.app.inject({ method: 'GET',
        url: `/api/management/workspaces/${args.workspaceId}/runs/${args.runId}`,
        headers: { authorization: `Bearer ${f.writer.token}` } }))
      expect(aggregate.statusCode, aggregate.body).toBe(409)
      expect(aggregate.json()).toMatchObject({ error: { code: 'RUN_DETAIL_TOO_LARGE' } })

      const persisted = (await f.db.pool.query<{ record: unknown; stopped: boolean; pending: boolean }>(
        `select r.record,r.stop_requested_at is not null as stopped,
         exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending) as pending
         from runs r where r.id=$1`, [args.runId])).rows[0]!
      const expected = WorkflowRunV3Schema.parse(persisted.record)
      delete expected.authorizationPrincipalId
      const full = RunRecordDetailSchema.parse(await parity(f, f.client, f.writer.token, name, args))
      expect(full).toEqual({ run: expected, stopRequested: persisted.stopped, cleanupPending: persisted.pending })
      expect(full.run.input).toEqual(fixture.run.input)
      expect(full.run.result).toBeDefined()
      expect(full.run.executionLocation).toEqual(queued.run.executionLocation)
      expect(full.run.agentConfigurationVersionIds).toEqual(queued.run.agentConfigurationVersionIds)
      expect(full.run.workflowVersionId).toBe(queued.run.workflowVersionId)
      expect(Object.keys(full).sort()).toEqual(['cleanupPending', 'run', 'stopRequested'])
      expect(Buffer.byteLength(JSON.stringify(full), 'utf8')).toBeLessThan(RUN_INSPECTION_LIMITS.responseBytes)
      expect(f.provider.counts).toEqual(counts)

      const restricted = await reader(f, [{ actions: ['runs:read'], scope: { runIds: [args.runId] } }])
      const redacted = RunRecordDetailSchema.parse(await parity(f, restricted.client, restricted.token, name, args))
      delete expected.executionLocation
      expect(redacted).toEqual({ run: expected, stopRequested: persisted.stopped, cleanupPending: persisted.pending })
      const forbidden = await reader(f, [{ actions: ['capabilities:read'], scope: {} }])
      expect((await forbidden.client.listTools()).tools.map((tool) => tool.name)).not.toContain(name)
      await denied(f, forbidden.client, forbidden.token, name, args, 403, 'ACCESS_DENIED')
      const audits = (await f.db.pool.query<{ source: string }>(
        'select source from management_audit where principal_id=$1', [forbidden.principal.id])).rows
      expect(audits.map((row) => row.source)).toEqual(expect.arrayContaining(['http', 'mcp']))
      const wrongScope = await reader(f, [{ actions: ['runs:read'], scope: { workspaceIds: ['other-workspace'] } }])
      await denied(f, wrongScope.client, wrongScope.token, name, args, 403, 'ACCESS_DENIED')
      await denied(f, f.client, f.writer.token, name, { ...args, workspaceId: 'missing-workspace' }, 404, 'RUN_NOT_FOUND')
      expect((await f.app.inject({ method: 'GET', url: path(args, name), headers: { authorization: 'Bearer invalid' } })).statusCode).toBe(401)

      // The database itself refuses to rewrite an admitted Run's version pin.
      await expect(f.db.pool.query("update runs set record=jsonb_set(record,'{workflowVersionId}',to_jsonb($2::text)) where id=$1",
        [args.runId, 'corrupt-version-pin'])).rejects.toThrow(/REPEAT_RUN_PIN_IMMUTABLE/)
      expect(await parity(f, f.client, f.writer.token, name, args)).toEqual(full)
      expect(f.dispatchErrors).toEqual([])
    } finally { await f.close() }
  }, 180_000)
})
