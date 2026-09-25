import { randomUUID } from 'node:crypto'

import pg from 'pg'
import { describe, expect, it } from 'vitest'
import { canonicalGraphJson } from '@graphql/contracts/wave25'

import { repeatOccurrenceMigrationSql } from '../src/infrastructure/repeatOccurrenceMigration.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { readRepeatDecision, readRepeatOccurrences } from '../src/modules/runs/repeatPostgres.js'
import { makeRepeatOccurrence, repeatDigest, repeatExecutionIdentity, repeatSuccessorInput } from '../src/modules/runs/repeatResolution.js'
import {
  ENG04_REPEAT_AT,
  exitDecision,
  firstOccurrence,
  makeSimpleRepeatFixture,
} from './helpers/eng04RepeatFixtures.js'

const enabled = process.env.RUN_ENG04_REPEAT_POSTGRES === '1'
const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgresql://graphql:graphql@127.0.0.1:5432/graphql'
const schemaName = () => `eng04_d_${randomUUID().replaceAll('-', '')}`

describe.skipIf(!enabled)('NIM-2648 ENG04-D real PostgreSQL repeat regression', () => {
  it('enforces occurrence lineage and legacy/repeat execution uniqueness with exact persisted readback', async () => {
    const schema = schemaName()
    const admin = new pg.Pool({ connectionString, connectionTimeoutMillis: 5000, query_timeout: 5000 })
    await admin.query(`create schema "${schema}"`)
    const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema},public`, connectionTimeoutMillis: 5000, query_timeout: 5000 })
    const fixture = makeSimpleRepeatFixture(2, { suffix: 'eng04-d-pg', runId: 'run-eng04-d-pg' })
    try {
      await pool.query(`
        create table workspaces (id text primary key);
        create table workflows (id text primary key, workspace_id text not null references workspaces(id));
        create table workflow_versions (id text primary key, workspace_id text not null, workflow_id text not null, record jsonb not null);
        create table runs (
          id text primary key, workspace_id text not null, workflow_id text not null,
          workflow_version_id text not null, record jsonb not null
        );
        create table harness_executions (
          id text primary key, run_id text not null, workflow_node_id text not null, agent_id text not null,
          attempt integer not null, record jsonb not null,
          unique (run_id, workflow_node_id, attempt)
        );
        create table management_command_receipts (
          principal_id text not null, operation text not null, command_id text not null,
          target_key text not null, input_hash text not null, result jsonb not null,
          primary key (principal_id,operation,command_id)
        );
        create table management_audit (
          id bigint generated always as identity primary key, principal_id text, source text not null,
          action text not null, target_key text not null, outcome text not null, details jsonb not null
        );
      `)
      await pool.query('insert into workspaces(id) values($1)', [fixture.scope.workspaceId])
      await pool.query('insert into workflows(id,workspace_id) values($1,$2)', [fixture.scope.workflowId, fixture.scope.workspaceId])
      await pool.query('insert into workflow_versions(id,workspace_id,workflow_id,record) values($1,$2,$3,$4::jsonb)', [
        fixture.version.id, fixture.scope.workspaceId, fixture.scope.workflowId, JSON.stringify(fixture.version),
      ])
      await pool.query('insert into runs(id,workspace_id,workflow_id,workflow_version_id,record) values($1,$2,$3,$4,$5::jsonb)', [
        fixture.scope.runId, fixture.scope.workspaceId, fixture.scope.workflowId, fixture.version.id, JSON.stringify(fixture.run),
      ])
      await pool.query(repeatOccurrenceMigrationSql)

      const first = firstOccurrence(fixture)
      const insertOccurrence = async (value: typeof first) => {
        const occurrence = value.occurrence
        const previous = occurrence.input.previous
        await pool.query(`insert into run_repeat_occurrences
          (occurrence_id,run_id,workspace_id,workflow_id,workflow_version_id,block_id,occurrence_index,binding_id,input_json,input_digest,
           previous_occurrence_id,previous_occurrence_index,previous_decision_id,previous_result_digest,record)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)`, [
          occurrence.identity.occurrenceId, fixture.scope.runId, fixture.scope.workspaceId, fixture.scope.workflowId,
          fixture.version.id, fixture.block.id, occurrence.identity.occurrenceIndex, occurrence.input.bindingId,
          canonicalGraphJson(value.input), occurrence.input.inputDigest, previous?.occurrenceId ?? null,
          previous?.occurrenceIndex ?? null, previous?.decisionId ?? null, previous?.acceptedResultDigest ?? null,
          JSON.stringify(occurrence),
        ])
      }
      await insertOccurrence(first)
      await expect(pool.query(`insert into run_repeat_occurrences
        (occurrence_id,run_id,workspace_id,workflow_id,workflow_version_id,block_id,occurrence_index,binding_id,input_json,input_digest,record)
        values($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10::jsonb)`, [
        'duplicate-index-occurrence', fixture.scope.runId, fixture.scope.workspaceId, fixture.scope.workflowId, fixture.version.id,
        fixture.block.id, 'duplicate-binding', canonicalGraphJson(first.input), repeatDigest(first.input),
        JSON.stringify({ ...first.occurrence, identity: { ...first.occurrence.identity, occurrenceId: 'duplicate-index-occurrence' }, input: { ...first.occurrence.input, bindingId: 'duplicate-binding' } }),
      ])).rejects.toThrow()

      const one = exitDecision(fixture, first.occurrence, 'issues', 'pg-review-1')
      const slotInput = canonicalGraphJson({ exact: 'pg-review-1' })
      const slotDigest = repeatDigest({ exact: 'pg-review-1' })
      const execIdentity = { ...repeatExecutionIdentity(one.completed), occurrence: first.occurrence.identity }
      await pool.query(`insert into run_repeat_slots(slot_id,run_id,occurrence_id,workflow_node_id,input_json,input_digest)
        values($1,$2,$3,$4,$5,$6)`, ['pg-slot-review-1', fixture.scope.runId, first.occurrence.identity.occurrenceId, 'review', slotInput, slotDigest])
      await pool.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,repeat_occurrence_id,record)
        values($1,$2,$3,$4,1,$5,$6::jsonb)`, [one.completed.id, fixture.scope.runId, 'review', 'agent-review', first.occurrence.identity.occurrenceId, JSON.stringify(one.completed)])
      await pool.query(`insert into run_repeat_executions(execution_id,run_id,slot_id,occurrence_id,technical_attempt,previous_execution_id,identity)
        values($1,$2,$3,$4,1,null,$5::jsonb)`, [one.completed.id, fixture.scope.runId, 'pg-slot-review-1', first.occurrence.identity.occurrenceId, JSON.stringify(execIdentity)])
      const resultJson = canonicalGraphJson(one.completed.result)
      const resultDigest = repeatDigest(one.completed.result)
      await pool.query(`insert into run_repeat_results(execution_id,run_id,occurrence_id,result_json,result_digest,accepted_at)
        values($1,$2,$3,$4,$5,$6)`, [one.completed.id, fixture.scope.runId, first.occurrence.identity.occurrenceId, resultJson, resultDigest, ENG04_REPEAT_AT])
      await pool.query(`insert into run_repeat_decisions(decision_id,occurrence_id,exit_execution_id,result_digest,record)
        values($1,$2,$3,$4,$5::jsonb)`, [one.decision.decisionId, first.occurrence.identity.occurrenceId, one.completed.id, resultDigest, JSON.stringify(one.decision)])

      const second = makeRepeatOccurrence(
        fixture.scope,
        fixture.block,
        repeatSuccessorInput(first.input, one.decision, one.completed.result!),
        one.decision,
      )
      await insertOccurrence(second)
      expect((await readRepeatOccurrences(pool, fixture.scope, fixture.block.id)).map((row) => row.identity.occurrenceIndex)).toEqual([1, 2])
      const metadata = await readRepeatDecision(pool, fixture.scope, first.occurrence.identity.occurrenceId)
      expect(metadata).toMatchObject({ decisionId: one.decision.decisionId, acceptedResultDigest: resultDigest, reason: 'repeat' })
      expect(metadata && 'resultData' in metadata).toBe(false)

      const secondExecution = { ...one.completed, id: 'pg-review-2', attempt: 1, input: {} }
      await pool.query(`insert into run_repeat_slots(slot_id,run_id,occurrence_id,workflow_node_id,input_json,input_digest)
        values($1,$2,$3,$4,$5,$6)`, ['pg-slot-review-2', fixture.scope.runId, second.occurrence.identity.occurrenceId, 'review', slotInput, slotDigest])
      await pool.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,repeat_occurrence_id,record)
        values($1,$2,$3,$4,1,$5,$6::jsonb)`, ['pg-review-2', fixture.scope.runId, 'review', 'agent-review', second.occurrence.identity.occurrenceId, JSON.stringify(secondExecution)])
      await expect(pool.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,repeat_occurrence_id,record)
        values($1,$2,$3,$4,1,$5,$6::jsonb)`, ['pg-review-2-duplicate', fixture.scope.runId, 'review', 'agent-review', second.occurrence.identity.occurrenceId, JSON.stringify({ ...secondExecution, id: 'pg-review-2-duplicate' })])).rejects.toThrow()

      await pool.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,record)
        values('legacy-done-1',$1,'done','agent-done',1,'{}'::jsonb)`, [fixture.scope.runId])
      await expect(pool.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,record)
        values('legacy-done-duplicate',$1,'done','agent-done',1,'{}'::jsonb)`, [fixture.scope.runId])).rejects.toThrow()
    } finally {
      await pool.end()
      await admin.query(`drop schema if exists "${schema}" cascade`)
      await admin.end()
    }
  }, 30000)

  it('replays an exact repeat command receipt once and rejects the same raw command ID with changed input', async () => {
    const schema = schemaName()
    const admin = new pg.Pool({ connectionString, connectionTimeoutMillis: 5000, query_timeout: 5000 })
    await admin.query(`create schema "${schema}"`)
    const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema},public`, connectionTimeoutMillis: 5000, query_timeout: 5000 })
    try {
      await pool.query(`
        create table management_command_receipts (
          principal_id text not null, operation text not null, command_id text not null,
          target_key text not null, input_hash text not null, result jsonb not null,
          primary key (principal_id,operation,command_id)
        );
        create table management_audit (
          id bigint generated always as identity primary key, principal_id text, source text not null,
          action text not null, target_key text not null, outcome text not null, details jsonb not null
        );
      `)
      const coordinator = new PostgresCommandCoordinator(pool)
      const principal = { id: 'operator-eng04-d', name: 'ENG04 D', audience: 'operator' as const, expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null, grants: [] }
      let performs = 0
      const execute = (payload: unknown) => coordinator.execute({
        principal,
        source: 'mcp',
        operation: 'repeat.save',
        commandId: 'raw-command-eng04-d-0001',
        targetKey: 'workflow:wf-eng04-d:repeat',
        payload,
        perform: async () => ({ persisted: ++performs, rawCommandId: 'raw-command-eng04-d-0001' }),
      })
      const first = await execute({ cap: 3, expectedRevision: 7 })
      const duplicate = await execute({ expectedRevision: 7, cap: 3 })
      expect(first.replayed).toBe(false)
      expect(duplicate).toEqual({ value: first.value, replayed: true })
      expect(performs).toBe(1)
      await expect(execute({ cap: 2, expectedRevision: 7 })).rejects.toMatchObject({ code: 'COMMAND_ID_CONFLICT' })
      expect(performs).toBe(1)
    } finally {
      await pool.end()
      await admin.query(`drop schema if exists "${schema}" cascade`)
      await admin.end()
    }
  }, 15000)
})
