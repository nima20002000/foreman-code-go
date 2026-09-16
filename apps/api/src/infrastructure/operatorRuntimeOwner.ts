import pg from 'pg'
import { DomainError } from '../modules/errors.js'

/** One API/native owner per database. A separate connection never consumes an application-pool slot. */
export class OperatorRuntimeOwner {
  private readonly client: pg.Client
  private held = false
  constructor(connectionString: string, onLost: (error: Error) => void) {
    this.client = new pg.Client({ connectionString, connectionTimeoutMillis: 5_000 })
    this.client.on('error', (error) => { if (this.held) { this.held = false; onLost(error) } })
  }
  async acquire(): Promise<void> {
    await this.client.connect()
    const result = await this.client.query<{ acquired: boolean }>('select pg_try_advisory_lock($1) as acquired', [710_014])
    if (!result.rows[0]?.acquired) {
      await this.client.end()
      throw new DomainError('OPERATOR_API_ALREADY_OWNED', 'Another API process owns the native runtime for this database. Multi-instance native execution is not enabled.', 503)
    }
    this.held = true
  }
  async close(): Promise<void> {
    const held = this.held; this.held = false
    try { if (held) await this.client.query('select pg_advisory_unlock($1)', [710_014]) } finally { await this.client.end() }
  }
}
