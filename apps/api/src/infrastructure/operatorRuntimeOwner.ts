import pg from 'pg'
import { DomainError } from '../modules/errors.js'

/** One API/native owner per database. A separate connection never consumes an application-pool slot. */
export class OperatorRuntimeOwner {
  private readonly client: pg.Client
  private held = false
  private closing = false
  private loss: Error | undefined
  private acquisition: Promise<void> | undefined
  private closure: Promise<void> | undefined
  private ending: Promise<void> | undefined

  constructor(connectionString: string, onLost: (error: Error) => void) {
    this.client = new pg.Client({ connectionString, connectionTimeoutMillis: 5_000 })
    const lost = (error: Error) => {
      if (this.ending || this.loss) return
      this.loss = error
      if (this.held) {
        this.held = false
        onLost(error)
      }
    }
    this.client.on('error', lost)
    this.client.on('end', () => lost(new Error('The native runtime ownership connection ended.')))
  }

  /** Passive authority for local telemetry; no lock acquisition or owner mutation. */
  get active(): boolean { return this.held && !this.closing && !this.loss }
  async readRuntimeEpoch(): Promise<string> {
    if (!this.active) throw new DomainError('NATIVE_RUNTIME_UNAVAILABLE', 'The original runtime owner is not active.', 503)
    const row = (await this.client.query<{ epoch: string }>(`select (extract(epoch from backend_start)*1000000)::bigint::text as epoch
      from pg_stat_activity where pid=pg_backend_pid()`)).rows[0]
    if (!this.active || !row?.epoch) throw new DomainError('NATIVE_RUNTIME_UNAVAILABLE', 'The original runtime owner epoch is unavailable.', 503)
    return row.epoch
  }

  acquire(): Promise<void> {
    if (this.closing) return Promise.reject(new Error('Native runtime ownership is closing.'))
    if (this.loss) return Promise.reject(this.loss)
    this.acquisition ??= Promise.resolve().then(async () => {
      try {
        await this.client.connect()
        if (this.closing) throw new Error('Native runtime ownership is closing.')
        const result = await this.client.query<{ acquired: boolean }>('select pg_try_advisory_lock($1) as acquired', [710_014])
        if (!result.rows[0]?.acquired) {
          throw new DomainError('OPERATOR_API_ALREADY_OWNED', 'Another API process owns the native runtime for this database. Multi-instance native execution is not enabled.', 503)
        }
        if (this.loss) throw this.loss
        this.held = true
      } catch (error) {
        // No protected work is admitted until acquisition succeeds.
        try { await this.end() } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Native runtime ownership acquisition cleanup failed.', { cause: cleanupError })
        }
        throw error
      }
    })
    return this.acquisition
  }

  /** Call only AFTER successful protected cleanup, never in a cleanup finally block. */
  close(): Promise<void> {
    this.closing = true
    this.closure ??= Promise.resolve().then(async () => {
      // A shutdown during connect must not leave a late-acquired lock behind.
      if (!this.acquisition) return
      await this.acquisition.catch(() => { /* ignore: the owner awaits the original promise; this observer prevents a duplicate unhandled rejection. */ })
      try {
        if (this.held) await this.client.query('select pg_advisory_unlock($1)', [710_014])
      } finally {
        this.held = false
        await this.end()
      }
    })
    return this.closure
  }

  private end(): Promise<void> {
    this.ending ??= Promise.resolve().then(() => this.client.end())
    return this.ending
  }
}
