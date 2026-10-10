import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { RespondToInteractionResponseSchema } from '@foreman-code/contracts'
import { CanonicalRunGraphCurrentSchema, CANONICAL_RUN_GRAPH_MCP_TOOLS,
  makeCurrentWorkflowFixture, parseWorkHandoffResult } from '@foreman-code/contracts/wave25'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { buildApp } from '../src/app.js'
import { OperatorInteractionService } from '../src/modules/interactions/operator.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { RunGraphReadService } from '../src/modules/run-graph/readService.js'
import { codexApprovalRuntime } from './helpers/codexApprovalRuntime.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { graphRpc, graphRpcValue } from './eng04-graph-composition-fixture.js'

it.skipIf(!postgresEnabled)('settles an owner direction choice without a native approval callback or another launch', async () => {
  const fixture = makeCurrentWorkflowFixture(randomUUID(), 'single')
  fixture.version.definition.handoffs = { contractVersion: 1 }
  fixture.version.definition.executionPolicy = { maxParallelism: 1, maxNodeExecutions: 1 }
  const output = { routing: { kind: 'finish' }, data: { latestDeliverable: { revision: 1 },
    remainingFindings: ['The owner still needs to review the result'] } }
  const f = await codexApprovalRuntime('user', { fixture, workflowOutput: async () => JSON.stringify(output) })
  const commands = new PostgresCommandCoordinator(f.db.pool)
  const app = buildApp({
    readiness: {
      database: { ping: async () => { await f.db.pool.query('select 1') } },
      checkpoints: { ping: async () => undefined },
    },
    operator: { access: f.access, services: {
    commands, interactions: new OperatorInteractionService(f.service),
    runGraph: new RunGraphReadService(f.db.pool, { qualifiedReads: true }),
  } as unknown as OperatorServices } })
  try {
    await app.ready()
    await f.engine.start(f.f.run.id)
    const [interaction] = await f.pending()
    expect(interaction).toMatchObject({ kind: 'work_direction', status: 'pending' })
    if (!interaction) throw new Error('Expected a direction interaction')
    await f.engine.start(f.f.run.id)
    expect(await f.runs.get(f.f.run.id)).toMatchObject({ executionState: 'waiting', outcome: 'pending' })
    const caller = await f.access.issue({ name: 'Direction owner', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{
        actions: ['runs:read', 'workflows:read', 'interactions:read', 'interactions:respond'],
        scope: { workspaceIds: [f.f.scope.workspaceId], runIds: [f.f.run.id] },
      }] })
    const call = async (name: string, args: unknown) => {
      const reply = await graphRpc(app, caller.token, 'tools/call', { name, arguments: args })
      expect(reply.result?.isError, JSON.stringify(reply)).not.toBe(true)
      return graphRpcValue(reply.result)
    }
    expect(await call('interaction_get', { interactionId: interaction.id })).toMatchObject({ canRespond: true })
    const decision = RespondToInteractionResponseSchema.parse(await call('interaction_respond', {
      interactionId: interaction.id, expectedRevision: interaction.revision, optionId: 'finish',
    }))
    expect(decision.interaction.status).toBe('delivered')
    await f.engine.start(f.f.run.id)
    const completed = await f.runs.get(f.f.run.id)
    expect(completed).toMatchObject({ executionState: 'completed', outcome: 'succeeded' })
    expect(parseWorkHandoffResult(completed?.result).data.remainingFindings).toEqual(output.data.remainingFindings)
    const graph = CanonicalRunGraphCurrentSchema.parse(await call(CANONICAL_RUN_GRAPH_MCP_TOOLS.current,
      { protocolVersion: 1, scope: f.f.scope }))
    expect(graph.state.run).toMatchObject({ executionState: 'completed', pendingInteractionCount: 0 })
    expect(graph.state.interactions).toEqual([])
    expect(graph.state.executions).toHaveLength(1)
    expect(f.counts()).toMatchObject({ prompts: 1, responses: 0 })
    expect(await call('interaction_get', { interactionId: interaction.id }))
      .toMatchObject({ interaction: decision.interaction, canRespond: false })
  } finally {
    await app.close()
    await f.close()
  }
}, 120_000)
