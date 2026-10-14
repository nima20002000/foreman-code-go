import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { faultWorkflowFixture, expectRecoveredFault } from './helpers/faultWorkflowFixture.js'
import { readUntil } from './helpers/observableCondition.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

describe.runIf(postgresEnabled)('workflow MCP startup readiness', () => {
  let fixture: Awaited<ReturnType<typeof faultWorkflowFixture>>
  beforeAll(async () => { fixture = await faultWorkflowFixture({ mcpUnavailable: true }) }, 10_000)
  afterAll(async () => { await fixture?.close() }, 10_000)

  // A temporarily unavailable Foreman Code MCP server must be retried before native turn entry.
  it.fails('waits for Foreman Code MCP at turn start and then completes', async () => {
    fixture.launch()
    await readUntil(async () => fixture.unavailableInspections, count => count > 0,
      { timeoutMs: 4_000, description: 'the unavailable Foreman Code MCP inspection' })
    const before = await fixture.read()
    expect(before.executions.filter(execution => execution.workflowNodeId === fixture.affected.id)
      .every(execution => !fixture.worker.replay.starts.some(turn =>
        turn.correlationId === `execution:${execution.id}`))).toBe(true)
    fixture.makeMcpReady()
    fixture.release()
    expectRecoveredFault(await fixture.finished(), fixture, /mcp|readiness|unavailable|retry/i)
  }, 18_000)
})
