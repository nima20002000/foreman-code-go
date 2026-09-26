import type pg from 'pg'
import { operatorLauncherPath, registerOperatorRouteDigest } from './operatorMcpLauncher.js'

/** Existing external Operator credentials follow this database's runtime owner after a port change. */
export class OperatorMcpRoutes {
  private readonly registered = new Map<string, () => Promise<void>>()
  constructor(private readonly pool: pg.Pool, private readonly endpoint: string, private readonly launcher = operatorLauncherPath()) {}
  async refresh(): Promise<void> {
    const result = await this.pool.query<{ token_hash: string; expires_at: Date }>(`select token_hash, expires_at
      from management_principals where audience='operator' and delegated_from is null
      and revoked_at is null and expires_at>now()`)
    const current = new Set(result.rows.map((row) => row.token_hash))
    for (const [digest, remove] of this.registered) {
      if (!current.has(digest)) { await remove(); this.registered.delete(digest) }
    }
    for (const row of result.rows) if (!this.registered.has(row.token_hash)) {
      this.registered.set(row.token_hash, await registerOperatorRouteDigest(row.token_hash, this.endpoint, row.expires_at.toISOString(), this.launcher))
    }
  }
  async close(): Promise<void> {
    await Promise.all([...this.registered.values()].map((remove) => remove()))
    this.registered.clear()
  }
}
