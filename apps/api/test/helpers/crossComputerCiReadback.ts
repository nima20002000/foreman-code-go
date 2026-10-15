import type { Client } from '@modelcontextprotocol/client'
import { CiGetOutputSchema, CiLogsOutputSchema, CiRunRecordSchema } from '@foreman-code/contracts'
import { expect } from 'vitest'
import { z } from 'zod'
import { callCiTool } from './crossComputerCiSetup.js'

const TerminalStateSchema = CiRunRecordSchema.shape.state.extract(['passed', 'failed', 'canceled', 'lost'])
// Agents may add notes such as verification details; every required field is still checked exactly.
export const AgentCiReportSchema = z.object({
  ticketId: CiRunRecordSchema.shape.id,
  groupId: CiRunRecordSchema.shape.groupId,
  suite: CiRunRecordSchema.shape.suite,
  outcome: TerminalStateSchema,
  repository: CiRunRecordSchema.shape.repository,
  branch: z.string().min(1).max(255),
  logLine: z.string().trim().min(1).max(2000),
  // Part, computer, commit and exit code come from ci_get; Agents only report what they observed.
  tickets: z.array(z.object({
    ticketId: CiRunRecordSchema.shape.id,
    outcome: TerminalStateSchema,
    observedStates: z.array(CiRunRecordSchema.shape.state).min(1).max(7),
  })).min(1).max(200),
}).superRefine((report, context) => {
  const ids = report.tickets.map(ticket => ticket.ticketId)
  if (new Set(ids).size !== ids.length || !ids.includes(report.ticketId)) {
    context.addIssue({ code: 'custom', message: 'Report every returned ticket exactly once, including the first.' })
  }
})
export type AgentCiReport = z.infer<typeof AgentCiReportSchema>
export type CiReadback = z.infer<typeof CiGetOutputSchema>

export function readAgentCiReport(output: unknown): AgentCiReport {
  const envelope = z.object({ text: z.string() }).safeParse(output)
  const raw = envelope.success ? envelope.data.text : output
  const value: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw
  // Workflow Agents return their deliverable inside the routed workflow output.
  const routed = z.object({ data: z.object({ latestDeliverable: z.unknown() }) }).safeParse(value)
  const deliverable = routed.success ? routed.data.data.latestDeliverable : value
  // The top-level ticketId only names the group handle; Agents sometimes omit it while reporting every ticket.
  const first = z.object({ tickets: z.array(z.object({ ticketId: z.string() })).min(1) }).safeParse(deliverable)
  const omitted = first.success && typeof deliverable === 'object' && deliverable !== null && !('ticketId' in deliverable)
  return AgentCiReportSchema.parse(omitted
    ? { ...deliverable, ticketId: first.data.tickets[0]!.ticketId } : deliverable)
}

export function ciTerminal(state: string): boolean {
  return TerminalStateSchema.safeParse(state).success
}

export async function readCiLog(client: Pick<Client, 'callTool'>, scope: { workspaceId: string; ticketId: string }) {
  let cursor = 0
  let text = ''
  for (let pageNumber = 0; pageNumber < 1024; pageNumber++) {
    const page = CiLogsOutputSchema.parse(await callCiTool(client, 'ci_logs_read', {
      ...scope, afterOffset: cursor, maxBytes: 65_536,
    }))
    expect(page.parts).toBeUndefined()
    expect(page.nextOffset).toBeGreaterThanOrEqual(cursor)
    expect(page.nextOffset).toBeLessThanOrEqual(page.logBytes)
    text += page.text
    if (page.nextOffset === page.logBytes) return { text, logBytes: page.logBytes }
    expect(page.nextOffset, 'A nonempty CI log page must advance its byte cursor').toBeGreaterThan(cursor)
    cursor = page.nextOffset
  }
  throw new Error('CI log read exceeded its bounded pagination budget.')
}

export function requireCiStateOrder(states: readonly string[]) {
  const order = ['queued', 'starting', 'running']
  let previous = -1
  for (const [index, state] of states.entries()) {
    const position = ciTerminal(state) ? 3 : order.indexOf(state)
    expect(position, 'CI state must be recognized').toBeGreaterThanOrEqual(0)
    if (state === 'queued') previous = -1
    expect(position, 'CI lifecycle must not regress within an attempt').toBeGreaterThanOrEqual(previous)
    if (ciTerminal(states[index - 1] ?? '')) expect(state).toBe(states[index - 1])
    previous = position
  }
  expect(ciTerminal(states.at(-1) ?? '')).toBe(true)
}
