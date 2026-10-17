import assert from 'node:assert/strict'
import { setTimeout } from 'node:timers/promises'
import {
  GetInteractionResponseSchema, ListInteractionsResponseSchema,
  type DurableInteraction,
} from '@foreman-code/contracts'
import {
  InteractionSummaryResultSchema, ManagedInteractionPageSchema, ManagedInteractionSchema,
} from '@foreman-code/contracts/management'
import { InteractionActivityProjectionSchema } from '@foreman-code/contracts/interaction-activity'
import type { WorkflowRunV3 } from '@foreman-code/contracts/wave25'
import { assertResponse } from '../../assertions.js'
import type { ScenarioContext } from '../../scenario.js'
import type { McpClient } from '../../clients/mcp.js'
import { assertProtectedRead } from '../http/support.js'
import { assertInvalidCallerDenied, callTool } from '../mcp/support.js'
import { assertApiError } from '../smoke/support.js'

export function interactionActivity(interaction: DurableInteraction, authorized = true) {
  const pending = interaction.status === 'pending'
  return InteractionActivityProjectionSchema.parse({ interactionId: interaction.id, revision: String(interaction.revision),
    owner: { workspaceId: interaction.workspaceId, workflowId: interaction.workflowId, runId: interaction.runId,
      executionId: interaction.executionId, agentId: interaction.requestingAgentId },
    native: { harness: 'codex', sessionId: interaction.nativeSessionId, requestId: interaction.nativeRequestId, turnId: 'turn-1' },
    phase: pending ? 'needs_answer' : 'delivered', answerRecorded: !pending,
    nativeDelivery: pending ? 'not_started' : 'delivered', workerAcknowledgment: pending ? 'unknown' : 'confirmed',
    response: { available: pending && authorized, path: pending && authorized ? 'live_callback' : null,
      reason: !pending ? 'not_pending' : authorized ? 'available' : 'unauthorized' },
  })
}

export function interactionCounts(interaction: DurableInteraction) {
  return interaction.status === 'pending'
    ? { pendingCount: 1, pendingByWorkflow: { [interaction.workflowId]: 1 } }
    : { pendingCount: 0, pendingByWorkflow: {} }
}

export async function waitForPendingInput(ctx: ScenarioContext, run: WorkflowRunV3) {
  const path = `/api/user/interactions?runId=${run.id}&limit=25`
  for (;;) {
    ctx.signal.throwIfAborted()
    const response = await ctx.http.request('GET', path)
    assert.equal(response.status, 200)
    const page = ListInteractionsResponseSchema.parse(response.body)
    assert.ok(page.items.length <= 1, 'This native turn must publish exactly one pending question')
    const interaction = page.items[0]
    if (interaction?.graphInterruptId) {
      const read = await ctx.http.request('GET', `/api/user/interactions/${interaction.id}`)
      const detail = GetInteractionResponseSchema.parse(read.body)
      assert.equal(detail.interaction.status, 'pending', 'The input must remain unanswered until this scenario responds')
      if (detail.canRespond) {
        assertResponse(response, { status: 200, body: { items: [detail.interaction], nextCursor: null } })
        assertResponse(read, { status: 200, body: { interaction: detail.interaction,
          activity: interactionActivity(detail.interaction), canRespond: true } })
        return detail.interaction
      }
    }
    await setTimeout(50, undefined, { signal: ctx.signal })
  }
}

export async function assertInteractionReads(ctx: ScenarioContext, interaction: DurableInteraction,
  operator: McpClient, readOnly: McpClient) {
  const pending = interaction.status === 'pending'
  const counts = interactionCounts(interaction)
  const query = `runId=${interaction.runId}&limit=25`
  const detail = { interaction, activity: interactionActivity(interaction), canRespond: pending }
  for (const [path, expected] of [
    [`/api/user/interactions?${query}`, { items: [interaction], nextCursor: null }],
    [`/api/user/interactions/${interaction.id}`, detail],
    [`/api/management/interactions?${query}`, { items: [interaction], nextCursor: null, ...counts }],
    [`/api/management/interactions/${interaction.id}`, detail],
  ] as const) {
    await assertProtectedRead(ctx, path, expected)
    if (path.startsWith('/api/user/')) {
      assertApiError(await ctx.http.request('GET', path, { token: ctx.target.operatorToken }),
        403, 'MCP_BROWSER_REVIEW_REQUIRED', 'Review this change in the local app.')
      assertResponse(await ctx.http.request('HEAD', path, { token: ctx.target.operatorToken }), { status: 403, body: null })
    }
  }
  const scope = { runId: interaction.runId }
  for (const client of [operator, readOnly]) {
    assert.deepStrictEqual(await callTool(client, 'interaction_summary', scope, InteractionSummaryResultSchema), counts)
    assert.deepStrictEqual(await callTool(client, 'interaction_list', { ...scope, limit: 25 }, ManagedInteractionPageSchema), {
      items: [interaction], pageInfo: { nextCursor: null }, ...counts,
    })
    assert.deepStrictEqual(await callTool(client, 'interaction_get', { interactionId: interaction.id }, ManagedInteractionSchema), {
      interaction, activity: interactionActivity(interaction, client === operator), canRespond: pending && client === operator,
    })
    for (const [name, input] of [
      ['interaction_summary', scope], ['interaction_list', { ...scope, limit: 25 }],
      ['interaction_get', { interactionId: interaction.id }],
    ] as const) await assertInvalidCallerDenied(client, name, input)
  }
}
