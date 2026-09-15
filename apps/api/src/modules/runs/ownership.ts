import pg from 'pg'

import { DomainError } from '../errors.js'

/**
 * PostgreSQL, not an API process's maps, arbitrates execution ownership.
 * A dedicated session avoids exhausting the application's query pool while
 * runs hold locks. Losing the session cancels work; interrupted work is never
 * automatically replayed, because a native tool may already have side effects.
 */
export class RunOwnership {
  private lost = false
  private released = false

  private constructor(readonly client: pg.Client, private readonly onLost: () => void) {}

  static async acquire(pool: pg.Pool, runId: string, onLost: () => void): Promise<RunOwnership | undefined> {
    const client = new pg.Client({ ...pool.options, application_name: 'graphql-run-owner' })
    const owner = new RunOwnership(client, onLost)
    client.on('error', owner.handleLoss)
    client.on('end', owner.handleLoss)
    try {
      await client.connect()
      const result = await client.query<{ acquired: boolean }>(
        'select pg_try_advisory_lock($1, hashtext($2)) as acquired',
        [810_002, runId],
      )
      if (result.rows[0]?.acquired) return owner
      await owner.release()
      return undefined
    } catch (error) {
      await owner.release()
      throw error
    }
  }

  private readonly handleLoss = () => {
    if (this.released || this.lost) return
    this.lost = true
    this.onLost()
  }

  assertOwned(): void {
    if (this.lost || this.released) {
      throw new DomainError('RUN_OWNERSHIP_LOST', 'The database execution owner disconnected. The run requires reconciliation.', 409)
    }
  }

  async release(): Promise<void> {
    if (this.released) return
    this.released = true
    // Closing, rather than returning this session to a pool, always releases
    // its advisory lock, including after a failed query or lost connection.
    await this.client.end().catch(() => undefined)
    this.client.removeListener('error', this.handleLoss)
    this.client.removeListener('end', this.handleLoss)
  }
}
