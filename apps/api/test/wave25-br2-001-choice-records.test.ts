import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { HarnessExecutionSchema, type HarnessExecution } from '@graphql/contracts'
import { canonicalGraphJson, type NodeResolution } from '@graphql/contracts/wave25'
import { ExclusiveGraphConnection, assertGraphTransaction } from '../src/modules/run-graph/connection.js'
import { graphSourceDigest, openRunGraphPublication } from '../src/modules/run-graph/publication.js'
import { putNodeResolution } from '../src/modules/run-graph/records.js'
import { oneShotResolution } from '../src/modules/runs/oneShotResolution.js'
import {
  br2001Fixture, br2001InvalidTexts, br2001Providers, br2001Terminal, br2001Text,
} from './helpers/wave25Br2001Choice.js'

type Fixture = ReturnType<typeof br2001Fixture>

/** Only the SQL transport is scripted. The actual transaction/publication guards,
 * schemas, digest checks and durable record writer run unchanged. These tests
 * catch a missing THIRD parser call without requiring PostgreSQL. They are not
 * proof of SQL constraints, real ownership or atomic database publication.
 */
async function writeResolution(f: Fixture, execution: HarnessExecution, resolution: NodeResolution,
  options: { accepted?: boolean; catchInside?: boolean } = {}) {
  const inserts: unknown[][] = []
  const commands: string[] = []
  const query = vi.fn(async (text: string, values: unknown[] = []) => {
    const sql = text.replace(/\s+/g, ' ').trim()
    commands.push(sql)
    let rows: Record<string, unknown>[]
    if (sql.startsWith('begin ') || sql === 'commit' || sql === 'rollback') rows = []
    else if (sql.startsWith('select r.workspace_id,r.workflow_id,r.workflow_version_id,v.execution_semantics_version')) {
      expect(values).toEqual([f.scope.runId])
      rows = [{ workspace_id: f.scope.workspaceId, workflow_id: f.scope.workflowId,
        workflow_version_id: f.scope.workflowVersionId, execution_semantics_version: 2 }]
    } else if (sql === 'select protocol_version from run_graph_heads where run_id=$1 for update') {
      expect(values).toEqual([f.scope.runId])
      rows = [{ protocol_version: 1 }]
    } else if (sql.startsWith('select v.record from runs r join workflow_versions v')) {
      expect(values).toEqual([f.scope.runId, resolution.workflowNodeId])
      rows = [{ record: f.version }]
    } else if (sql.startsWith('select record,accepted from harness_executions')) {
      expect(values).toEqual([f.scope.runId, resolution.workflowNodeId])
      rows = [{ record: execution, accepted: options.accepted ?? true }]
    } else if (sql.startsWith('insert into run_node_resolutions(')) {
      inserts.push(values)
      rows = [{ run_id: f.scope.runId }]
    } else throw new Error(`Unexpected choice record test SQL: ${sql}`)
    return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] }
  })
  const connection = new ExclusiveGraphConnection({ query } as unknown as pg.ClientBase, () => undefined)
  let rejected = false, error: unknown
  try {
    await connection.transaction(async (sql) => {
      await openRunGraphPublication(sql, f.scope)
      if (!options.catchInside) return putNodeResolution(sql, f.scope, resolution)
      // Even a caller swallowing the parser error cannot commit this transaction.
      await expect(putNodeResolution(sql, f.scope, resolution)).rejects.toThrow()
      expect(() => assertGraphTransaction(sql)).toThrow('GRAPH_TRANSACTION_FAILED')
    })
  } catch (cause) { rejected = true; error = cause }
  finally { await connection.close() }
  return { rejected, error, inserts, commands }
}

function successfulResolution(f: Fixture, execution: HarnessExecution, outcome = 'pass'): NodeResolution {
  // Deliberately form the claim from a known valid envelope, independent of the
  // stored raw result. Negative tests supply a plausible but untrusted claim.
  const reference = HarnessExecutionSchema.parse({ ...execution, result: {
    outcome: 'succeeded', output: { routing: { outcome }, data: null },
  } })
  return { ...oneShotResolution(f.version, reference), acceptedResultDigest: graphSourceDigest(execution.result) }
}

function expectRejected(attempt: Awaited<ReturnType<typeof writeResolution>>) {
  expect(attempt.rejected).toBe(true)
  expect(attempt.error).toBeInstanceOf(Error)
  expect(attempt.inserts).toEqual([])
  expect(attempt.commands).toContain('rollback')
  expect(attempt.commands).not.toContain('commit')
}

describe.each(br2001Providers)('BR2-001: %s durable choice revalidation', (provider) => {
  it.each(['pass', 'issues'])('writes %s from the exact accepted raw carrier', async (outcome) => {
    const f = br2001Fixture(provider, `br2001-record-${provider}`)
    const terminal = br2001Terminal(f.executions[0]!, provider, br2001Text(outcome, { provider }))
    const before = structuredClone(terminal.execution)
    const resolution = successfulResolution(f, terminal.execution, outcome)
    const attempt = await writeResolution(f, terminal.execution, resolution)
    expect(attempt.error).toBeUndefined()
    expect(attempt.rejected).toBe(false)
    expect(attempt.inserts).toEqual([[f.scope.runId, resolution.workflowNodeId, 'succeeded',
      terminal.execution.id, 1, canonicalGraphJson(resolution)]])
    expect(attempt.commands).toContain('commit')
    expect(attempt.commands).not.toContain('rollback')
    expect(terminal.execution).toEqual(before)
    expect(resolution.acceptedResultDigest).toBe(graphSourceDigest(terminal.result))
    expect(resolution.selectedRelationshipIds).toEqual(outcome === 'issues' ? [f.version.definition.edges[0]!.id] : [])
    expect(resolution.branchEnded).toBe(outcome === 'pass')
  })

  it.each(br2001InvalidTexts)('independently rejects stored $name despite a matching raw digest', async ({ text }) => {
    const f = br2001Fixture(provider, `br2001-record-invalid-${provider}`)
    const execution = br2001Terminal(f.executions[0]!, provider, text).execution
    expectRejected(await writeResolution(f, execution, successfulResolution(f, execution)))
  })

  it('does not accept mixed, nested, non-string or array carriers', async () => {
    const f = br2001Fixture(provider, `br2001-record-mixed-${provider}`)
    const text = br2001Text(), base = br2001Terminal(f.executions[0]!, provider, text).execution
    for (const output of [
      { text, extra: true }, { text, routing: { outcome: 'issues' }, data: null },
      { text: JSON.parse(text) }, { text: null }, { text: 0 }, { output: { text } }, [{ text }],
    ]) {
      const execution = HarnessExecutionSchema.parse({ ...base, result: { outcome: 'succeeded', output } })
      expectRejected(await writeResolution(f, execution, successfulResolution(f, execution)))
    }
  })

  it('preserves raw byte limits at the independent durable boundary', async () => {
    const f = br2001Fixture(provider, `br2001-record-bound-${provider}`)
    const empty = br2001Terminal(f.executions[0]!, provider, br2001Text('pass', ''))
    const overhead = Buffer.byteLength(canonicalGraphJson(empty.result), 'utf8')
    const data = 'x'.repeat(64 * 1024 - overhead)
    const atLimit = br2001Terminal(f.executions[0]!, provider, br2001Text('pass', data)).execution
    const allowed = await writeResolution(f, atLimit, successfulResolution(f, atLimit))
    expect(allowed.error).toBeUndefined()
    expect(allowed.inserts).toHaveLength(1)
    const overLimit = br2001Terminal(f.executions[0]!, provider, br2001Text('pass', data + 'x')).execution
    expectRejected(await writeResolution(f, overLimit, successfulResolution(f, overLimit)))
  })

  it('cannot commit after a swallowed choice-validation error', async () => {
    const f = br2001Fixture(provider, `br2001-record-poison-${provider}`)
    const execution = br2001Terminal(f.executions[0]!, provider, 'not JSON').execution
    const attempt = await writeResolution(f, execution, successfulResolution(f, execution), { catchInside: true })
    expectRejected(attempt)
    expect(attempt.error).toMatchObject({ code: 'GRAPH_TRANSACTION_FAILED' })
  })

  it('retains acceptance, raw digest, identity, immutable pin and declared-route checks', async () => {
    const f = br2001Fixture(provider, `br2001-record-fences-${provider}`)
    const terminal = br2001Terminal(f.executions[0]!, provider, br2001Text('issues'))
    const execution = terminal.execution, resolution = successfulResolution(f, execution, 'issues')
    expectRejected(await writeResolution(f, execution, resolution, { accepted: false }))
    for (const proposed of [
      { ...resolution, acceptedResultDigest: graphSourceDigest({ outcome: 'succeeded', output: terminal.result.output.text }) },
      { ...resolution, outcome: 'pass', branchEnded: true, selectedRelationshipIds: [],
        unselectedRelationshipIds: [f.version.definition.edges[0]!.id] },
      { ...resolution, execution: { ...resolution.execution!, executionId: 'different-execution' } },
      { ...resolution, selectedRelationshipIds: ['different-edge'], unselectedRelationshipIds: [] },
    ]) expectRejected(await writeResolution(f, execution, proposed))
    for (const record of [
      { ...execution, runId: 'different-run' },
      { ...execution, agentConfigurationVersionId: 'different-pin' },
      { ...execution, attempt: 2 },
      { ...execution, state: 'running', result: undefined, finishedAt: undefined },
    ]) expectRejected(await writeResolution(f, HarnessExecutionSchema.parse(record), resolution))
  })

  it('preserves direct string/object choice results and ordinary non-choice results', async () => {
    const f = br2001Fixture(provider, `br2001-record-compat-${provider}`)
    const base = br2001Terminal(f.executions[0]!, provider, br2001Text()).execution
    for (const output of [br2001Text(), JSON.parse(br2001Text()), { text: ` \n${br2001Text()}\t ` }]) {
      const execution = HarnessExecutionSchema.parse({ ...base, result: { outcome: 'succeeded', output } })
      const attempt = await writeResolution(f, execution, successfulResolution(f, execution))
      expect(attempt.error).toBeUndefined()
      expect(attempt.inserts).toHaveLength(1)
    }
    delete f.version.definition.nodes[0]!.choice
    for (const output of [{ text: 'ordinary reply' }, 'plain text', { done: true }]) {
      const execution = HarnessExecutionSchema.parse({ ...base, result: { outcome: 'succeeded', output } })
      const resolution = oneShotResolution(f.version, execution)
      const attempt = await writeResolution(f, execution, resolution)
      expect(attempt.error).toBeUndefined()
      expect(attempt.inserts).toHaveLength(1)
      expect(resolution.outcome).toBeUndefined()
      expect(resolution.selectedRelationshipIds).toEqual([f.version.definition.edges[0]!.id])
    }
  })
})
