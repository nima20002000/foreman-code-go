import { commandInputHash } from '@graphql/contracts/command-identity-node'
export { commandInputHash } from '@graphql/contracts/command-identity-node'

import type { ManagementPrincipal } from '@graphql/contracts/management'
import pg from 'pg'

import { DomainError } from '../errors.js'


export class PostgresCommandCoordinator {
  constructor(private readonly pool: pg.Pool) {}

  async execute<T>(input: {
    principal: ManagementPrincipal
    source: 'http' | 'mcp'
    operation: string
    commandId: string
    targetKey: string
    payload: unknown
    perform(client: pg.PoolClient): Promise<T>
    /** Revalidate live authority under the command lock, including receipt reads.
     * Transactional callers may retain their authority row locks through COMMIT. */
    authorize?(client: pg.PoolClient): Promise<void>
    /** Lifecycle callbacks may await runtime cleanup that needs the application pool. */
    dedicatedConnection?: true
    /** Explicit compatibility boundary for historical receipts, never new commands. */
    replayResult?(result: unknown): T
  }): Promise<{ value: T; replayed: boolean }> {
    const inputHash = commandInputHash(input.payload)
    const commandPool = input.dedicatedConnection
      ? new pg.Pool({ ...this.pool.options, max: 1, application_name: 'graphql-lifecycle-command' }) : this.pool
    const client = await commandPool.connect().catch(async (error: unknown) => {
      if (commandPool !== this.pool) await commandPool.end()
      throw error
    })
    let releaseError: Error | undefined
    let inTransaction = false
    let lifecycleLock = false
    const commandLock = `command:${input.principal.id}:${input.operation}:${input.commandId}`
    try {
      await client.query('begin')
      inTransaction = true
      if (input.dedicatedConnection) {
        await client.query('select pg_advisory_lock(hashtext($1))', [commandLock])
        lifecycleLock = true
      } else {
        await client.query('select pg_advisory_xact_lock(hashtext($1))', [commandLock])
      }
      await input.authorize?.(client)
      const existing = await client.query<{ input_hash: string; target_key: string; result: unknown }>(
        `select input_hash, target_key, result from management_command_receipts
         where principal_id = $1 and operation = $2 and command_id = $3`,
        [input.principal.id, input.operation, input.commandId],
      )
      const receipt = existing.rows[0]
      if (receipt) {
        if (receipt.input_hash !== inputHash || receipt.target_key !== input.targetKey) {
          throw new DomainError('COMMAND_ID_CONFLICT', 'This command ID was already used with different input.', 409)
        }
        const value = input.replayResult ? input.replayResult(receipt.result) : receipt.result as T
        await client.query('commit')
        inTransaction = false
        return { value, replayed: true }
      }

      // A lifecycle callback can wait for runtime cleanup and database work.
      // Keep its command identity serialized by the session advisory lock, but
      // do not retain row locks while the idempotent callback runs.
      if (input.dedicatedConnection) {
        await client.query('commit')
        inTransaction = false
      }
      const value = await input.perform(client)
      if (input.dedicatedConnection) {
        await client.query('begin')
        inTransaction = true
      }
      await client.query(
        `insert into management_command_receipts
          (principal_id, operation, command_id, target_key, input_hash, result)
         values ($1, $2, $3, $4, $5, $6::jsonb)`,
        [input.principal.id, input.operation, input.commandId, input.targetKey, inputHash, JSON.stringify(value)],
      )
      await client.query(
        `insert into management_audit (principal_id, source, action, target_key, outcome, details)
         values ($1, $2, $3, $4, 'succeeded', $5::jsonb)`,
        [input.principal.id, input.source, input.operation, input.targetKey, JSON.stringify({ commandId: input.commandId })],
      )
      await client.query('commit')
      inTransaction = false
      return { value, replayed: false }
    } catch (error) {
      if (inTransaction) {
        try {
          await client.query('rollback')
          inTransaction = false
        } catch (rollbackError) {
          // A failed rollback leaves connection state unknown. Evict it, and
          // preserve the command error rather than replacing it with cleanup.
          releaseError = rollbackError instanceof Error ? rollbackError : new Error('Command rollback failed.')
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
            code: error instanceof DomainError ? error.code : 'INTERNAL_ERROR',
          })],
        ).catch(() => undefined)
      }
      throw error
    } finally {
      if (lifecycleLock && !releaseError) {
        await client.query('select pg_advisory_unlock(hashtext($1))', [commandLock]).catch(() => undefined)
      }
      client.release(releaseError)
      if (commandPool !== this.pool) await commandPool.end()
    }
  }

  async recordDenied(principalId: string | undefined, source: 'http' | 'mcp', action: string, targetKey: string): Promise<void> {
    await this.pool.query(
      `insert into management_audit (principal_id, source, action, target_key, outcome, details)
       values ($1, $2, $3, $4, 'denied', '{}'::jsonb)`,
      [principalId ?? null, source, action, targetKey],
    )
  }

  async recordAudit(
    principalId: string | undefined,
    source: 'http' | 'mcp',
    action: string,
    targetKey: string,
    outcome: 'succeeded' | 'failed' | 'uncertain',
    details: Record<string, unknown> = {},
    client?: pg.ClientBase,
  ): Promise<void> {
    await (client ?? this.pool).query(
      `insert into management_audit (principal_id, source, action, target_key, outcome, details)
       values ($1, $2, $3, $4, $5, $6::jsonb)`,
      [principalId ?? null, source, action, targetKey, outcome, JSON.stringify(details)],
    )
  }
}
