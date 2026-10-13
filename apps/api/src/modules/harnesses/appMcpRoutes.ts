import type pg from 'pg'
import { appLauncherPath, registerAppRouteDigest } from './appMcpLauncher.js'

/** Operator and Worker credentials follow their owning database across restarts, port changes and lease renewals. */
export class AppMcpRoutes {
  private readonly registered = new Map<string, () => Promise<void>>()
  private pending: Promise<void> = Promise.resolve()
  constructor(private readonly pool: pg.Pool, private readonly endpoint: string, private readonly launcher = appLauncherPath()) {}
  refresh(): Promise<void> {
    const next = this.pending.then(() => this.refreshRoutes())
    this.pending = next.catch(() => { /* ignore: a failed earlier operation is reported to its own caller; this queue only orders the next one */ })
    return next
  }
  private async refreshRoutes(): Promise<void> {
    // Delegated Operator chat credentials register their own route for the conversation lifetime.
    const result = await this.pool.query<{ token_hash: string; expires_at: Date }>(`select token_hash, expires_at
      from management_principals where audience='operator' and delegated_from is null
      and token_hash is not null and revoked_at is null and expires_at>now()
      union all
      select p.token_hash, p.expires_at
      from management_principals p join worker_credential_bindings b on b.principal_id=p.id where p.audience='worker'
      and p.revoked_at is null and b.revoked_at is null and p.expires_at>now()`)
    const current = new Set(result.rows.map((row) => row.token_hash))
    for (const [digest, remove] of this.registered) {
      if (!current.has(digest)) { await remove(); this.registered.delete(digest) }
    }
    for (const row of result.rows) {
      this.registered.set(row.token_hash, await registerAppRouteDigest(row.token_hash, this.endpoint, row.expires_at.toISOString(), this.launcher))
    }
  }
  async close(): Promise<void> {
    await this.pending
    await Promise.all([...this.registered.values()].map((remove) => remove()))
    this.registered.clear()
  }
}
