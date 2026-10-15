import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import * as verifier from './helpers/crossComputerCiVerification.js'

function fixture(): Parameters<typeof verifier.verifyScenario>[0] {
  return JSON.parse(readFileSync(new URL('./fixtures/cross-computer-ci.json', import.meta.url), 'utf8'))
}

it('replays a saved round offline with terminal-only samples and product-owned identifiers', () => {
  const recorded = fixture()
  recorded.tickets[0]!.latest.smokeComputer = recorded.tickets[0]!.latest.computer!.hostRef
  expect(() => verifier.verifyScenario(recorded)).not.toThrow()
})

it('requires tickets to execute on at least two computers', () => {
  const recorded = fixture()
  recorded.tickets[1]!.latest.computer = recorded.tickets[0]!.latest.computer
  expect(() => verifier.verifyScenario(recorded)).toThrow('At least two computers')
})

it('collects independent product failures in one diagnostic', () => {
  const recorded = fixture()
  recorded.runs[0]!.run.outcome = 'failed'
  recorded.reports['execution-1'] = { ...recorded.reports['execution-1'] as object, logLine: 'Invented log line' }
  recorded.tickets[1]!.latest.initiator.executionId = 'foreign-execution'
  expect(() => verifier.verifyScenario(recorded)).toThrow(/workflow.*outcome[\s\S]*logLine[\s\S]*executionId/i)
})

it.each(['scope', 'owner', 'order', 'reference'] as const)('rejects incorrect activity %s', change => {
  const recorded = fixture()
  const items = recorded.activities['run-1']!
  const job = items[1]!
  if (change === 'scope') job.scope.runId = 'run-2'
  if (change === 'owner') job.refs.executionId = 'execution-2'
  if (change === 'order') job.sequence = '4'
  if (change === 'reference') {
    job.refs.jobExecutionId = job.refs.ciTicketId!
    delete job.refs.ciTicketId
  }
  expect(() => verifier.verifyScenario(recorded)).toThrow()
})

it('checks each Agent succeeds once and has its own product worktree branch', () => {
  const recorded = fixture()
  recorded.runs[0]!.executions.push({ ...recorded.runs[0]!.executions[0]!, id: 'duplicate' })
  recorded.workflows[1]!.repository = recorded.workflows[0]!.repository
  recorded.runs[1]!.worktrees![0]!.branch = recorded.runs[0]!.worktrees![0]!.branch
  expect(() => verifier.verifyScenario(recorded)).toThrow(/succeeds once[\s\S]*own branch/)
})
