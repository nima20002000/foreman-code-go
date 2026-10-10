import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
export { commandInputHash } from '@foreman-code/contracts/command-identity-node'

import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import pg from 'pg'

import { DomainError } from '../errors.js'
import type { GraphSqlClient } from '../run-graph/connection.js'

function commitWasRejected(error: unknown): boolean {
  if (!(error instanceof pg.DatabaseError) || !error.code) return false
  // SQLSTATE is not localized. This is used only after a successful rollback;
  // connection failures and unknown completion still leave COMMIT ambiguous.
  return !error.code.startsWith('08') && error.code !== '40003'
}

export class PostgresCommandCoordinator {
  constructor(private readonly pool: pg.Pool) {}

  async execute<T>(input: {
    principal: ManagementPrincipal
    source: 'http' | 'mcp' | 'device'
    operation: string
    commandId: string
    targetKey: string
    payload: unknown
    /** Serialize local external effects through transaction rollback and compensation. */
    resourceLock?: string
    perform(client: pg.PoolClient): Promise<T>
    /** Revalidate live authority under the command lock, including receipt reads.
     * Transactional callers may retain their authority row locks through COMMIT. */
    authorize?(client: pg.PoolClient): Promise<void>
    /** Compensate external effects only after a confirmed rollback, using the idle connection. */
    afterRollback?(client: pg.PoolClient): Promise<void>
    /** Lifecycle callbacks may await runtime cleanup that needs the application pool. */
    dedicatedConnection?: true
    /** Prepare immutable bytes or installed metadata outside SQL under retained
     * command ownership. Admission and its receipt then share one transaction. */
    prepare?(): Promise<void>
    /** Explicit compatibility boundary for historical receipts, never new commands. */
    replayResult?(result: unknown): T
    /** Resume an unfinished external operation under its original command lock. */
    shouldResumeReceipt?(client: pg.PoolClient): Promise<boolean>
  }): Promise<{ value: T; replayed: boolean }> {
    const inputHash = commandInputHash(input.payload)
    const dedicatedConnection = input.dedicatedConnection || input.prepare !== undefined
    const commandPool = dedicatedConnection
      ? new pg.Pool({ ...this.pool.options, max: 1, application_name: 'graphql-lifecycle-command' }) : this.pool
    const client = await commandPool.connect().catch(async (error: unknown) => {
      if (commandPool !== this.pool) await commandPool.end()
      throw error
    })
    let releaseError: Error | undefined
    let inTransaction = false
    let lifecycleLock = false
    let resourceLocked = false
    let committing = false
    let performing = false
    const commandLock = `command:${input.principal.id}:${input.operation}:${input.commandId}`
    try {
      await client.query('begin')
      inTransaction = true
      if (dedicatedConnection) {
        await client.query('select pg_advisory_lock(hashtext($1))', [commandLock])
        lifecycleLock = true
      } else {
        await client.query('select pg_advisory_xact_lock(hashtext($1))', [commandLock])
      }
      if (input.resourceLock) {
        await client.query('select pg_advisory_lock(hashtext($1))', [input.resourceLock])
        resourceLocked = true
      }
      await input.authorize?.(client)
      const existing = await client.query<{ input_hash: string; target_key: string; result: unknown }>(
        `select input_hash, target_key, result from management_command_receipts
         where principal_id = $1 and operation = $2 and command_id = $3`,
        [input.principal.id, input.operation, input.commandId],
      )
      const receipt = existing.rows[0]
      let resumingReceipt = false
      if (receipt) {
        if (receipt.input_hash !== inputHash || receipt.target_key !== input.targetKey) {
          throw new DomainError('COMMAND_ID_CONFLICT', 'This command ID was already used with different input.', 409)
        }
        resumingReceipt = await input.shouldResumeReceipt?.(client) ?? false
        if (!resumingReceipt) {
          const value = input.replayResult ? input.replayResult(receipt.result) : receipt.result as T
          await client.query('commit')
          inTransaction = false
          return { value, replayed: true }
        }
      }

      // A lifecycle callback can wait for runtime cleanup and database work.
      // Keep its command identity serialized by the session advisory lock, but
      // do not retain row locks while the idempotent callback runs.
      if (dedicatedConnection) {
        await client.query('commit')
        inTransaction = false
      }
      if (input.prepare) {
        await input.prepare()
        await client.query('begin')
        inTransaction = true
        await input.authorize?.(client)
      }
      performing = true
      const value = await input.perform(client)
      if (dedicatedConnection && !input.prepare) {
        await client.query('begin')
        inTransaction = true
      }
      if (resumingReceipt) {
        await client.query(
          `update management_command_receipts set result=$4::jsonb
           where principal_id=$1 and operation=$2 and command_id=$3`,
          [input.principal.id, input.operation, input.commandId, JSON.stringify(value)],
        )
      } else {
        await client.query(
          `insert into management_command_receipts
          (principal_id, operation, command_id, target_key, input_hash, result)
         values ($1, $2, $3, $4, $5, $6::jsonb)`,
          [input.principal.id, input.operation, input.commandId, input.targetKey, inputHash, JSON.stringify(value)],
        )
      }
      await client.query(
        `insert into management_audit (principal_id, source, action, target_key, outcome, details)
         values ($1, $2, $3, $4, 'succeeded', $5::jsonb)`,
        [input.principal.id, input.source, input.operation, input.targetKey, JSON.stringify({ commandId: input.commandId })],
      )
      committing = true
      await client.query('commit')
      inTransaction = false
      return { value, replayed: false }
    } catch (error) {
      let failure = error
      let rolledBack = false
      if (inTransaction) {
        try {
          await client.query('rollback')
          inTransaction = false
          rolledBack = true
        } catch (rollbackError) {
          // A failed rollback leaves connection state unknown. Evict it, and
          // preserve the command error rather than replacing it with cleanup.
          releaseError = rollbackError instanceof Error ? rollbackError : new Error('Command rollback failed.')
        }
      }
      if (performing && rolledBack && (!committing || commitWasRejected(error))) {
        try {
          await input.afterRollback?.(client)
        } catch (cleanupError) {
          failure = new AggregateError([error, cleanupError], 'The command and rollback cleanup failed.')
          try {
            await client.query('rollback')
          } catch (rollbackError) {
            releaseError = rollbackError instanceof Error ? rollbackError : new Error('Command cleanup rollback failed.')
          }
        }
      }
      if (!releaseError) {
        // Reuse this now-idle client. Asking the pool for a second connection
        // while retaining the first deadlocks a saturated pool.
        await client.query(
          `insert into management_audit (principal_id, source, action, target_key, outcome, details)
           values ($1, $2, $3, $4, 'failed', $5::jsonb)`,
          [input.principal.id, input.source, input.operation, input.targetKey, JSON.stringify({
            commandId: input.commandId,
            code: failure instanceof DomainError ? failure.code : 'INTERNAL_ERROR',
            ...(failure !== error ? { cleanupFailed: true } : {}),
          })],
        ).catch(() => undefined)
      }
      throw failure
    } finally {
      if (resourceLocked && !releaseError) {
        await client.query('select pg_advisory_unlock(hashtext($1))', [input.resourceLock]).catch((error: unknown) => {
          releaseError = error instanceof Error ? error : new Error('Command resource unlock failed.')
        })
      }
      if (lifecycleLock && !releaseError) {
        await client.query('select pg_advisory_unlock(hashtext($1))', [commandLock]).catch((error: unknown) => {
          releaseError = error instanceof Error ? error : new Error('Command unlock failed.')
        })
      }
      client.release(releaseError)
      if (commandPool !== this.pool) await commandPool.end()
    }
  }

  async recordDenied(principalId: string | undefined, source: 'http' | 'mcp' | 'device', action: string, targetKey: string): Promise<void> {
    await this.pool.query(
      `insert into management_audit (principal_id, source, action, target_key, outcome, details)
       values ($1, $2, $3, $4, 'denied', '{}'::jsonb)`,
      [principalId ?? null, source, action, targetKey],
    )
  }

  async recordAudit(
    principalId: string | undefined,
    source: 'http' | 'mcp' | 'device',
    action: string,
    targetKey: string,
    outcome: 'succeeded' | 'failed' | 'uncertain',
    details: Record<string, unknown> = {},
    client?: GraphSqlClient,
  ): Promise<void> {
    await (client ?? this.pool).query(
      `insert into management_audit (principal_id, source, action, target_key, outcome, details)
       values ($1, $2, $3, $4, $5, $6::jsonb)`,
      [principalId ?? null, source, action, targetKey, outcome, JSON.stringify(details)],
    )
  }
}
