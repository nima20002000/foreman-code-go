import type pg from 'pg'
import { randomUUID } from 'node:crypto'
import { appLauncherPath, registerAppRouteDigest, type AppMcpRouteRegistration } from './appMcpLauncher.js'

interface RuntimeRouteOwner {
  readonly active: boolean
  readRuntimeEpoch(): Promise<string>
}

/** Operator and Worker credentials follow their owning database across restarts, port changes and lease renewals. */
export class AppMcpRoutes {
  private readonly registered = new Map<string, AppMcpRouteRegistration>()
  private readonly runtimeEpoch = randomUUID()
  private pending: Promise<void> = Promise.resolve()
  private closing = false

  constructor(
    private readonly pool: pg.Pool, private readonly endpoint: string, private readonly launcher = appLauncherPath(),
    private readonly owner?: () => RuntimeRouteOwner,
  ) {}

  refresh(): Promise<void> {
    if (this.closing) return Promise.reject(new Error('MCP route publication is closing.'))
    const next = this.pending.then(() => this.refreshRoutes())
    this.pending = next.catch(() => { /* ignore: the previous caller receives its failure; queued operations still need to settle. */ })
    return next
  }

  private assertActive(): void {
    if (this.closing || this.owner && !this.owner().active) {
      throw new Error('The MCP route runtime owner is no longer active.')
    }
  }

  private async refreshRoutes(): Promise<void> {
    this.assertActive()
    const runtimeEpoch = this.owner ? await this.owner().readRuntimeEpoch() : this.runtimeEpoch
    // Delegated Operator chat credentials register their own route for the conversation lifetime.
    const result = await this.pool.query<{ token_hash: string; expires_at: Date }>(`select token_hash, expires_at
      from management_principals where audience='operator' and delegated_from is null
      and token_hash is not null and revoked_at is null and expires_at>now()
      union all
      select p.token_hash, p.expires_at
      from management_principals p join worker_credential_bindings b on b.principal_id=p.id where p.audience='worker'
      and p.revoked_at is null and b.revoked_at is null and p.expires_at>now()`)
    this.assertActive()
    const current = new Set(result.rows.map(row => row.token_hash))
    for (const [digest, remove] of this.registered) {
      if (!current.has(digest)) {
        await remove()
        this.registered.delete(digest)
      }
    }
    for (const row of result.rows) {
      this.assertActive()
      const existing = this.registered.get(row.token_hash)
      if (existing) await existing.refresh(row.expires_at.toISOString())
      else {
        const registration = await registerAppRouteDigest(row.token_hash, this.endpoint,
          row.expires_at.toISOString(), this.launcher, { runtimeEpoch, assertActive: () => this.assertActive() })
        this.registered.set(row.token_hash, registration)
      }
    }
  }

  stopAdmission(): void {
    this.closing = true
  }

  async close(): Promise<void> {
    this.stopAdmission()
    await this.pending
    await Promise.all([...this.registered.values()].map(remove => remove()))
    this.registered.clear()
  }
}
