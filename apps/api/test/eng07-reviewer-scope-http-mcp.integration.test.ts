import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { describe, expect, it, vi } from 'vitest'
import { AgentConfigurationVersionSchema } from '@graphql/contracts'
import { CURRENT_WORKFLOW_TOOLS, CurrentWorkflowSaveInputSchema, CurrentWorkflowSaveResultSchema,
  ExecutableWorkflowV3Schema, WorkflowVersionV3Schema } from '@graphql/contracts/wave25'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { postgresEnabled, seedAgent3 } from './helpers/wave25Agent3.js'
import { reviewerScopeFixture, supportedReviewerScopes, unsupportedReviewerScopes,
  type ReviewerScopeCase } from './helpers/eng07ReviewAdmission.testSupport.js'
import { definitionUrl, rpc, saveThrough, transports, type SaveFixture, type Transport } from './helpers/eng07SaveAdmission.testSupport.js'
import { graphHeaders, graphRpcValue } from './eng04-graph-composition-fixture.js'

const code = 'REPEAT_REVIEW_SCOPE_UNSUPPORTED'
async function counts(f: SaveFixture, workflowId: string) {
  const result = await f.db.pool.query(`select
    (select count(*)::int from workflow_versions where workflow_id=$1) as versions,
    (select count(*)::int from runs where workflow_id=$1) as runs`, [workflowId])
  return result.rows[0]
}
async function candidate(f: SaveFixture, kind: ReviewerScopeCase) {
  const target = reviewerScopeFixture(kind), baseline = structuredClone(target)
  delete baseline.version.definition.repeat
  for (const node of baseline.version.definition.nodes) delete node.choice
  await seedAgent3(f.db.pool, f.db.directory, baseline, { run: false })
  const row = (await f.db.pool.query('select revision::text from workflows where id=$1', [baseline.scope.workflowId])).rows[0]!
  return { target, baseline, input: CurrentWorkflowSaveInputSchema.parse({
    workspaceId: baseline.scope.workspaceId, workflowId: baseline.scope.workflowId,
    commandId: randomUUID(), executionSemanticsVersion: 3, expectedRevision: Number(row.revision),
    expectedWorkflowVersionId: baseline.version.id, expectedLocationRevision: 1,
    expectedAgentConfigurationVersionIds: baseline.version.agentConfigurationVersionIds,
    graph: { ...target.version.definition, id: baseline.scope.workflowId, version: baseline.version.version,
      createdAt: baseline.version.definition.createdAt, updatedAt: baseline.version.definition.updatedAt,
      nodes: target.version.definition.nodes.map((node) => ({ ...node, initialPrompt: `ENG07 reviewer scope: ${kind}` })) },
  }) }
}
async function rejected(f: SaveFixture, transport: Transport, tool: string, url: string,
  method: 'POST' | 'PUT', input: Record<string, unknown>) {
  const start = tool === 'run_start'
  const errorCode = start ? 'INVALID_REQUEST' : 'GRAPH_INVALID'
  if (transport === 'http') {
    const reply = await f.app.inject({ method, url, headers: graphHeaders(f.writer.token), payload: input })
    expect(reply.statusCode, reply.body).toBe(start ? 400 : 409)
    expect(reply.json()).toMatchObject({ error: { code: errorCode } })
    expect(JSON.stringify(reply.json().error.details)).toContain(code)
  } else {
    const reply = await rpc(f, tool, input)
    expect(reply.result?.isError, JSON.stringify(reply)).toBe(true)
    const value = graphRpcValue(reply.result as unknown as Parameters<typeof graphRpcValue>[0])
    expect(value).toMatchObject({ error: { code: errorCode } })
    expect(JSON.stringify(value)).toContain(code)
  }
}

for (const transport of transports) describe.skipIf(!postgresEnabled)(`ENG07 reviewer scope HTTP/MCP admission: ${transport}`, () => {
  it.each(unsupportedReviewerScopes)('%s is rejected at Validate and Save without publication', async (kind) => {
    const f = await currentOperatorIntegration({ approvalNodeIds: [] })
    try {
      const { input } = await candidate(f, kind)
      const { commandId, ...validation } = input; void commandId
      await rejected(f, transport, CURRENT_WORKFLOW_TOOLS.validate, `${definitionUrl(input)}/validate`, 'POST', validation)
      await rejected(f, transport, CURRENT_WORKFLOW_TOOLS.save, definitionUrl(input), 'PUT', input)
      expect(await counts(f, input.workflowId)).toEqual({ versions: 1, runs: 0 })
      expect((await f.db.pool.query('select current_version_id from workflows where id=$1', [input.workflowId])).rows[0]!.current_version_id)
        .toBe(input.expectedWorkflowVersionId)
      expect(f.provider.counts.sessions).toBe(0); expect(f.provider.counts.starts).toBe(0)
      expect((await f.db.pool.query(`select 1 from management_command_receipts where principal_id=$1
        and operation='workflow.save.v3' and command_id=$2`, [f.writer.principal.id, input.commandId])).rows).toEqual([])
    } finally { await f.close() }
  }, 60000)

  it.each(supportedReviewerScopes)('%s still validates and saves through the shared executable schema', async (kind) => {
    const f = await currentOperatorIntegration({ approvalNodeIds: [] })
    try {
      const { input, target } = await candidate(f, kind)
      const { commandId, ...validation } = input; void commandId
      if (transport === 'http') {
        const reply = await f.app.inject({ method: 'POST', url: `${definitionUrl(input)}/validate`, headers: graphHeaders(f.writer.token), payload: validation })
        expect(reply.statusCode, reply.body).toBe(200)
        expect(reply.json()).toMatchObject({ valid: true, executionSemanticsVersion: 3 })
      } else {
        const reply = await rpc(f, CURRENT_WORKFLOW_TOOLS.validate, validation)
        expect(reply.result?.isError, JSON.stringify(reply)).not.toBe(true)
        expect(graphRpcValue(reply.result as unknown as Parameters<typeof graphRpcValue>[0])).toMatchObject({ valid: true, executionSemanticsVersion: 3 })
      }
      const saved = CurrentWorkflowSaveResultSchema.parse(await saveThrough(f, transport, input))
      expect(saved.value.currentVersionId).not.toBe(input.expectedWorkflowVersionId)
      expect(ExecutableWorkflowV3Schema.parse({ version: saved.value.version, configurations: target.configurations }).version).toEqual(saved.value.version)
      expect(Object.hasOwn(saved.value.version.definition, 'repeat')).toBe(kind !== 'ordinary')
      expect(await counts(f, input.workflowId)).toEqual({ versions: 2, runs: 0 })
      expect(f.provider.counts.starts).toBe(0)
    } finally { await f.close() }
  }, 60000)

  it.each(unsupportedReviewerScopes)('%s cannot Start a version accepted before this validator fix', async (kind) => {
    const f = await currentOperatorIntegration({ approvalNodeIds: [] })
    try {
      const historical = reviewerScopeFixture(kind)
      const shape = z.object({ version: WorkflowVersionV3Schema, configurations: z.array(AgentConfigurationVersionSchema) }).strict()
      const safeParse = ExecutableWorkflowV3Schema.safeParse.bind(ExecutableWorkflowV3Schema)
      let legacyParses = 0
      // Setup ONLY: emulate the old validator's single omission while retaining
      // every other executable check and the REAL typed Save/publication writer.
      // No SQL evidence/receipt forging. Restore BEFORE either Start transport.
      const legacyValue = (raw: unknown) => {
        const result = safeParse(raw)
        if (result.success) return result.data
        expect(result.error.issues).toHaveLength(1)
        expect(result.error.issues[0]!.message).toContain(code)
        const value = shape.parse(raw)
        expect(value.version.workspaceId).toBe(historical.scope.workspaceId)
        legacyParses++
        return value
      }
      const oldValidator = vi.spyOn(ExecutableWorkflowV3Schema, 'parse').mockImplementation(legacyValue)
      const oldSafeValidator = vi.spyOn(ExecutableWorkflowV3Schema, 'safeParse').mockImplementation((raw) => ({
        success: true, data: legacyValue(raw),
      }))
      try { await seedAgent3(f.db.pool, f.db.directory, historical, { run: false }) }
      finally { oldSafeValidator.mockRestore(); oldValidator.mockRestore() }
      expect(legacyParses).toBeGreaterThan(0)
      expect(ExecutableWorkflowV3Schema.safeParse({ version: historical.version, configurations: historical.configurations }).success).toBe(false)
      const row = (await f.db.pool.query('select revision::text from workflows where id=$1', [historical.scope.workflowId])).rows[0]!
      const input = { workspaceId: historical.scope.workspaceId, workflowId: historical.scope.workflowId,
        workflowVersionId: historical.version.id, executionSemanticsVersion: 3, commandId: randomUUID(),
        expectedWorkflowRevision: Number(row.revision), expectedAgentConfigurationVersionIds: historical.version.agentConfigurationVersionIds,
        expectedLocationRevision: 1, input: {} }
      await rejected(f, transport, 'run_start', `/api/management/workspaces/${input.workspaceId}/workflows/${input.workflowId}/runs`, 'POST', input)
      expect(await counts(f, input.workflowId)).toEqual({ versions: 1, runs: 0 })
      expect(f.provider.counts.sessions).toBe(0); expect(f.provider.counts.starts).toBe(0)
      expect((await f.db.pool.query(`select 1 from management_command_receipts where principal_id=$1
        and operation='run.start' and command_id=$2`, [f.writer.principal.id, input.commandId])).rows).toEqual([])
    } finally { await f.close() }
  }, 60000)
})
