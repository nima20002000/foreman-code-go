import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { describe, expect, it, vi } from 'vitest'
import { AgentConfigurationVersionSchema } from '@graphql/contracts'
import { CURRENT_WORKFLOW_TOOLS, CurrentWorkflowReadResultSchema, CurrentWorkflowSaveInputSchema,
  ExecutableWorkflowV3Schema, WorkflowVersionV3Schema } from '@graphql/contracts/wave25'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { remoteReviewerPlacementFixture } from './helpers/remoteReviewerPlacement.js'
import { postgresEnabled, seedAgent3 } from './helpers/wave25Agent3.js'
import { definitionUrl, rpc, transports, type SaveFixture, type Transport } from './helpers/eng07SaveAdmission.testSupport.js'
import { graphHeaders, graphRpcValue } from './eng04-graph-composition-fixture.js'

const code = 'REMOTE_REVIEWER_UNSUPPORTED'

async function persisted(f: SaveFixture, workflowId: string) {
  return (await f.db.pool.query(`select
    (select count(*)::int from workflow_versions where workflow_id=$1) as versions,
    (select count(*)::int from runs where workflow_id=$1) as runs`, [workflowId])).rows[0]
}

async function rejected(f: SaveFixture, transport: Transport, tool: string, url: string,
  method: 'POST' | 'PUT', input: Record<string, unknown>) {
  const starting = tool === 'run_start'
  let value: unknown
  if (transport === 'http') {
    const response = await f.app.inject({ method, url, headers: graphHeaders(f.writer.token), payload: input })
    expect(response.statusCode, response.body).toBe(starting ? 400 : 409)
    value = response.json()
  } else {
    const response = await rpc(f, tool, input)
    expect(response.result.isError).toBe(true)
    value = graphRpcValue(response.result as Parameters<typeof graphRpcValue>[0])
  }
  expect(value).toMatchObject({ error: { code: starting ? 'INVALID_REQUEST' : 'GRAPH_INVALID' } })
  expect(JSON.stringify(value)).toContain(code)
}

async function savedVersion(f: SaveFixture, scope: { workspaceId: string; workflowId: string }) {
  const response = await rpc(f, CURRENT_WORKFLOW_TOOLS.saved, scope)
  expect(response.result.isError).not.toBe(true)
  return CurrentWorkflowReadResultSchema.parse(graphRpcValue(response.result as Parameters<typeof graphRpcValue>[0]))
}

for (const transport of transports) describe.skipIf(!postgresEnabled)(`remote reviewer admission: ${transport}`, () => {
  it('rejects Validate and Save without changing the persisted workflow', async () => {
    const f = await currentOperatorIntegration({ approvalNodeIds: [] })
    try {
      const { baseline, remote } = remoteReviewerPlacementFixture()
      await seedAgent3(f.db.pool, f.db.directory, baseline, { run: false })
      const before = await savedVersion(f, baseline.scope)
      const revision = (await f.db.pool.query('select revision::text from workflows where id=$1',
        [baseline.scope.workflowId])).rows[0]!.revision
      const input = CurrentWorkflowSaveInputSchema.parse({
        workspaceId: baseline.scope.workspaceId, workflowId: baseline.scope.workflowId,
        commandId: randomUUID(), executionSemanticsVersion: 3, expectedRevision: Number(revision),
        expectedWorkflowVersionId: baseline.version.id, expectedLocationRevision: 1,
        expectedAgentConfigurationVersionIds: baseline.version.agentConfigurationVersionIds,
        graph: { ...remote.version.definition, id: baseline.scope.workflowId,
          version: baseline.version.version, createdAt: baseline.version.definition.createdAt,
          updatedAt: baseline.version.definition.updatedAt },
      })
      const { commandId, ...validation } = input
      await rejected(f, transport, CURRENT_WORKFLOW_TOOLS.validate, `${definitionUrl(input)}/validate`, 'POST', validation)
      await rejected(f, transport, CURRENT_WORKFLOW_TOOLS.save, definitionUrl(input), 'PUT', input)
      expect(await savedVersion(f, baseline.scope)).toEqual(before)
      expect(await persisted(f, input.workflowId)).toEqual({ versions: 1, runs: 0 })
      expect(f.provider.counts.starts).toBe(0)
      expect((await f.db.pool.query('select 1 from management_command_receipts where command_id=$1',
        [commandId])).rows).toEqual([])
    } finally { await f.close() }
  }, 60_000)

  it('rejects Start of an older saved remote reviewer before creating a Run or native session', async () => {
    const f = await currentOperatorIntegration({ approvalNodeIds: [] })
    try {
      const { remote } = remoteReviewerPlacementFixture()
      const shape = z.object({ version: WorkflowVersionV3Schema,
        configurations: z.array(AgentConfigurationVersionSchema) }).strict()
      const parse = ExecutableWorkflowV3Schema.safeParse.bind(ExecutableWorkflowV3Schema)
      // Emulate only the old admission omission while the public Save writer seeds history.
      const oldValue = (raw: unknown) => {
        const result = parse(raw)
        if (result.success) return result.data
        expect(result.error.issues).toHaveLength(1)
        expect(result.error.issues[0]!.message).toContain(code)
        return shape.parse(raw)
      }
      const oldParse = vi.spyOn(ExecutableWorkflowV3Schema, 'parse').mockImplementation(oldValue)
      const oldSafeParse = vi.spyOn(ExecutableWorkflowV3Schema, 'safeParse').mockImplementation(raw => ({
        success: true, data: oldValue(raw),
      }))
      try { await seedAgent3(f.db.pool, f.db.directory, remote, { run: false }) }
      finally { oldSafeParse.mockRestore(); oldParse.mockRestore() }
      const before = await savedVersion(f, remote.scope)
      const revision = (await f.db.pool.query('select revision::text from workflows where id=$1',
        [remote.scope.workflowId])).rows[0]!.revision
      const input = { workspaceId: remote.scope.workspaceId, workflowId: remote.scope.workflowId,
        workflowVersionId: remote.version.id, executionSemanticsVersion: 3, commandId: randomUUID(),
        expectedWorkflowRevision: Number(revision), expectedLocationRevision: 1,
        expectedAgentConfigurationVersionIds: remote.version.agentConfigurationVersionIds, input: {} }
      await rejected(f, transport, 'run_start',
        `/api/management/workspaces/${input.workspaceId}/workflows/${input.workflowId}/runs`, 'POST', input)
      expect(await savedVersion(f, remote.scope)).toEqual(before)
      expect(await persisted(f, input.workflowId)).toEqual({ versions: 1, runs: 0 })
      expect(f.provider.counts.sessions).toBe(0)
      expect(f.provider.counts.starts).toBe(0)
      expect((await f.db.pool.query('select 1 from management_command_receipts where command_id=$1',
        [input.commandId])).rows).toEqual([])
    } finally { await f.close() }
  }, 60_000)
})

describe.skipIf(!postgresEnabled)('remote reviewer MCP permissions', () => {
  it('denies a read-only caller Save and Start while preserving readback', async () => {
    const f = await currentOperatorIntegration({ approvalNodeIds: [] })
    try {
      const { baseline, remote } = remoteReviewerPlacementFixture()
      await seedAgent3(f.db.pool, f.db.directory, baseline, { run: false })
      const before = await savedVersion(f, baseline.scope)
      const reader = await f.access.issue({ name: 'Workflow reader', audience: 'operator',
        expiresAt: new Date(Date.now() + 300_000), grants: [{
          actions: ['workflows:read', 'graph:read'], scope: { workspaceIds: [baseline.scope.workspaceId] },
        }] })
      const client = await f.connect(reader.token)
      const read = await client.callTool({ name: CURRENT_WORKFLOW_TOOLS.saved,
        arguments: { workspaceId: baseline.scope.workspaceId, workflowId: baseline.scope.workflowId } })
      expect(CurrentWorkflowReadResultSchema.parse(graphRpcValue(read as Parameters<typeof graphRpcValue>[0]))).toEqual(before)
      const input = { workspaceId: baseline.scope.workspaceId, workflowId: baseline.scope.workflowId,
        executionSemanticsVersion: 3, expectedLocationRevision: 1,
        expectedAgentConfigurationVersionIds: baseline.version.agentConfigurationVersionIds }
      const save = await client.callTool({ name: CURRENT_WORKFLOW_TOOLS.save, arguments: { ...input,
        commandId: randomUUID(), expectedRevision: before.revision,
        expectedWorkflowVersionId: baseline.version.id,
        graph: { ...remote.version.definition, id: baseline.scope.workflowId } } })
      const start = await client.callTool({ name: 'run_start', arguments: { ...input,
        commandId: randomUUID(), expectedWorkflowRevision: before.revision,
        workflowVersionId: baseline.version.id, input: {} } })
      for (const response of [save, start]) {
        expect(response.isError).toBe(true)
        expect(JSON.stringify(response.content)).toContain('ACCESS_DENIED')
      }
      expect(await savedVersion(f, baseline.scope)).toEqual(before)
      expect(await persisted(f, baseline.scope.workflowId)).toEqual({ versions: 1, runs: 0 })
      expect(f.provider.counts.sessions).toBe(0)
    } finally { await f.close() }
  }, 60_000)
})
