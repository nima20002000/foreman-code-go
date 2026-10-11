import type { Client } from '@modelcontextprotocol/client'
import { CiGetOutputSchema, CiLogsOutputSchema, CiRunRecordSchema } from '@foreman-code/contracts'
import { expect } from 'vitest'
import { z } from 'zod'
import { CiComputerHostSchema } from './crossComputerCiInput.js'
import { callCiTool } from './crossComputerCiSetup.js'

const TerminalStateSchema = CiRunRecordSchema.shape.state.extract(['passed', 'failed', 'canceled', 'lost'])
export const AgentCiReportSchema = z.object({
  ticketId: CiRunRecordSchema.shape.id,
  groupId: CiRunRecordSchema.shape.groupId,
  suite: CiRunRecordSchema.shape.suite,
  outcome: TerminalStateSchema,
  repository: CiRunRecordSchema.shape.repository,
  branch: z.string().min(1).max(255),
  tickets: z.array(z.object({
    ticketId: CiRunRecordSchema.shape.id,
    part: CiRunRecordSchema.shape.part,
    partition: CiRunRecordSchema.shape.partition,
    computer: CiComputerHostSchema,
    commit: CiRunRecordSchema.shape.commit,
    outcome: TerminalStateSchema,
    exitCode: CiRunRecordSchema.shape.exitCode,
    logLine: z.string().trim().min(1).max(2000),
    observedStates: z.array(CiRunRecordSchema.shape.state).min(1).max(7),
  }).strict()).min(1).max(66),
}).strict().superRefine((report, context) => {
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
  return AgentCiReportSchema.parse(typeof raw === 'string' ? JSON.parse(raw) : raw)
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
    expect(position, 'CI lifecycle must not regress').toBeGreaterThanOrEqual(previous)
    if (ciTerminal(states[index - 1] ?? '')) expect(state).toBe(states[index - 1])
    previous = position
  }
  expect(ciTerminal(states.at(-1) ?? '')).toBe(true)
}
