import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { HarnessMcpPlanInputSchema, HarnessMcpPlanSchema, type HarnessMcpPlan, type HarnessMcpPlanInput, type ManagementPrincipal } from '@graphql/contracts/management'
import { requireAuthorization } from '../access/policy.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { assertChange, publicMcpList, type NativeMcpAdapter } from './nativeMcpCommon.js'
import { qualificationError } from './qualificationErrors.js'

type Harness = 'codex' | 'opencode'
type Row = { id: string; harness: Harness; revision: string; change: unknown; requested_by: string; status: string; created_at: Date; expires_at: Date; error: string | null }
const projection = (row: Row): HarnessMcpPlan => HarnessMcpPlanSchema.parse({ id: row.id, harness: row.harness, revision: row.revision,
  change: row.change, requestedBy: row.requested_by, status: row.status, createdAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString(), error: row.error })

/** Native configuration writes are external effects: the durable marker precedes the one write. */
export class HarnessMcpSettingsService {
  private readonly stopping = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly reads = new Map<Harness, Promise<ReturnType<typeof publicMcpList>>>()
  constructor(private readonly pool: pg.Pool, private readonly commands: PostgresCommandCoordinator,
    private readonly adapters: Record<Harness, NativeMcpAdapter>, private readonly changed: () => void,
    private readonly closeProcesses: () => Promise<unknown> = async () => undefined) {}
  private async work<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.stopping.signal.aborted) throw new DomainError('HARNESS_SETTINGS_CLOSING', 'Harness settings are shutting down.', 503)
    if (this.pending.size >= 8) throw new DomainError('MCP_SETTINGS_BUSY', 'Native settings are busy. Try again after the current operation finishes.', 503)
    const signal = AbortSignal.any([this.stopping.signal, AbortSignal.timeout(60_000)])
    const task = Promise.resolve().then(() => run(signal))
    this.pending.add(task)
    try { return await task } finally { this.pending.delete(task) }
  }
  async shutdown(): Promise<void> {
    this.stopping.abort()
    await Promise.allSettled([...this.pending])
    // This callback must complete before the production runtime ownership lock is released.
    await this.closeProcesses()
  }
  async recover(): Promise<void> {
    await this.closeProcesses()
    // A durable submitting marker is not proof of delivery or non-delivery. Never replay it.
    await this.pool.query("update harness_mcp_change_plans set status='uncertain', error='Server restarted during this change. Inspect the native configuration before making another change.' where status='submitting'")
  }
  async list(principal: ManagementPrincipal, harness: Harness) {
    requireAuthorization(principal, 'harnesses:read')
    const active = this.reads.get(harness)
    if (active) return active
    const reading = this.work(async (signal) => {
      try { return publicMcpList(await this.adapters[harness].read(signal)) }
      catch (error) { throw qualificationError(error) }
    })
    this.reads.set(harness, reading)
    const clear = () => { if (this.reads.get(harness) === reading) this.reads.delete(harness) }
    void reading.then(clear, clear)
    return reading
  }
  async plans(principal: ManagementPrincipal, harness: Harness) {
    requireAuthorization(principal, 'harnesses:read')
    const result = await this.pool.query<Row>(`select * from harness_mcp_change_plans where harness=$1
      and ($2::boolean or requested_by=$3) order by created_at desc limit 50`, [harness, await this.isRoot(principal), principal.id])
    return { items: result.rows.map(projection) }
  }
  private async isRoot(principal: ManagementPrincipal): Promise<boolean> {
    const result = await this.pool.query("select 1 from management_principals where id=$1 and audience='operator' and delegated_from is null and revoked_at is null and expires_at>now()", [principal.id])
    return result.rowCount === 1
  }
  async get(principal: ManagementPrincipal, id: string) {
    requireAuthorization(principal, 'harnesses:read')
    const result = await this.pool.query<Row>('select * from harness_mcp_change_plans where id=$1 and ($2::boolean or requested_by=$3)', [id, await this.isRoot(principal), principal.id])
    if (!result.rows[0]) throw new DomainError('MCP_PLAN_NOT_FOUND', 'This MCP change is unavailable.', 404)
    return projection(result.rows[0])
  }
  async plan(principal: ManagementPrincipal, source: 'http' | 'mcp', raw: HarnessMcpPlanInput) {
    requireAuthorization(principal, 'harnesses:update')
    requireAuthorization(principal, 'harnesses:read')
    const input = HarnessMcpPlanInputSchema.parse(raw)
    // Idempotency receipt is checked before probing a potentially changed native installation.
    try { return await this.commands.execute({ principal, source, operation: 'harness.mcp.plan', commandId: input.commandId,
      targetKey: `harness-mcp:${input.harness}`, payload: input,
      perform: async (client) => this.work(async (signal) => {
        const snapshot = await this.adapters[input.harness].read(signal)
        if (snapshot.revision !== input.expectedRevision) throw new DomainError('REVISION_CONFLICT', 'Native configuration changed. Refresh the list before reviewing this change.', 409)
        assertChange(snapshot, input.change)
        const pending = await client.query("select 1 from harness_mcp_change_plans where harness=$1 and status in ('pending','submitting','uncertain') and (status <> 'pending' or expires_at>now()) limit 100", [input.harness])
        if (pending.rowCount && pending.rowCount >= 100) throw new DomainError('MCP_PLAN_LIMIT', 'Resolve existing MCP changes before adding more.', 409)
        const inserted = await client.query<Row>(`insert into harness_mcp_change_plans(id,harness,revision,change,requested_by,status,expires_at)
          values($1,$2,$3,$4::jsonb,$5,'pending',now()+interval '10 minutes') returning *`, [randomUUID(), input.harness, input.expectedRevision, JSON.stringify(input.change), principal.id])
        return projection(inserted.rows[0]!)
      }),
    }) } catch (error) { throw qualificationError(error) }
  }
  private async liveUser(client: pg.PoolClient, principal: ManagementPrincipal): Promise<void> {
    if (principal.audience !== 'operator') throw new DomainError('MCP_HUMAN_REVIEW_REQUIRED', 'A browser management credential is required.', 403)
    const active = await client.query<{ grants: ManagementPrincipal['grants']; expires_at: Date }>(
      "select grants,expires_at from management_principals where id=$1 and audience='operator' and delegated_from is null and revoked_at is null and expires_at>now() for share", [principal.id])
    if (!active.rows[0]) throw new DomainError('PRINCIPAL_REVOKED', 'Sign in again to review this change.', 401)
    requireAuthorization({ ...principal, grants: active.rows[0].grants, expiresAt: active.rows[0].expires_at.toISOString() }, 'harnesses:update')
  }
  async decide(principal: ManagementPrincipal, id: string, approve: boolean): Promise<HarnessMcpPlan> {
    requireAuthorization(principal, 'harnesses:update')
    // Browser transport is checked by the HTTP route; delegated credentials are denied below.
    return this.work(async (signal) => {
      const client = await this.pool.connect()
      let locked = false
      let destroyed = false
      let submitted = false
      let selected: HarnessMcpPlan | undefined
      try {
        await this.liveUser(client, principal)
        // One connection owns the lock until native cleanup completes, including uncertain outcomes.
        const lock = await client.query<{ locked: boolean }>("select pg_try_advisory_lock(hashtext('graphql:harness-mcp-settings')) as locked")
        locked = lock.rows[0]?.locked === true
        if (!locked) throw new DomainError('MCP_SETTINGS_BUSY', 'Another MCP change is being applied.', 409)
        const row = await client.query<Row>('select * from harness_mcp_change_plans where id=$1', [id])
        if (!row.rows[0]) throw new DomainError('MCP_PLAN_NOT_FOUND', 'This MCP change is unavailable.', 404)
        selected = projection(row.rows[0])
        if (selected.status !== 'pending') return selected // no replay, including submitting/uncertain
        if (Date.parse(selected.expiresAt) <= Date.now()) throw new DomainError('MCP_PLAN_EXPIRED', 'This review expired. Refresh and create a new change.', 409)
        if (approve) {
          const unsettled = await client.query("select 1 from harness_mcp_change_plans where id<>$1 and status in ('submitting','uncertain') limit 1", [id])
          if (unsettled.rowCount) throw new DomainError('MCP_RECONCILIATION_REQUIRED', 'An earlier native write is unresolved. Inspect its configuration and runner process before applying another change.', 409)
        }
        const snapshot = approve ? await this.adapters[selected.harness].read(signal) : undefined
        if (snapshot && snapshot.revision !== selected.revision) throw new DomainError('REVISION_CONFLICT', 'Native configuration changed after this review was prepared. Create a new change.', 409)
        if (snapshot) assertChange(snapshot, selected.change)
        await client.query('begin')
        try {
          await this.liveUser(client, principal)
          const updated = await client.query<Row>(`update harness_mcp_change_plans set status=$2,decided_by=$3
            where id=$1 and status='pending' and expires_at>now() returning *`, [id, approve ? 'submitting' : 'rejected', principal.id])
          if (!updated.rows[0]) throw new DomainError('MCP_PLAN_CHANGED', 'This change is no longer awaiting review.', 409)
          await client.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details)
            values($1,'http','harness.mcp.review',$2,$3,$4::jsonb)`, [principal.id, `harness-mcp:${selected.harness}`, 'succeeded', JSON.stringify({ planId: id, decision: approve ? 'approve' : 'reject' })])
          await client.query('commit')
        } catch (error) { await client.query('rollback'); throw error }
        if (!approve) return this.get(principal, id)
        submitted = true
        signal.throwIfAborted()
        await this.adapters[selected.harness].apply(snapshot!, selected.change, signal)
        await client.query('begin')
        try {
          await client.query("update harness_mcp_change_plans set status='applied',error=null where id=$1 and status='submitting'", [id])
          await client.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details)
            values($1,'http','harness.mcp.apply',$2,'succeeded',$3::jsonb)`, [principal.id, `harness-mcp:${selected.harness}`, JSON.stringify({ planId: id })])
          await client.query('commit')
        } catch (error) { await client.query('rollback'); throw error }
        this.changed()
        return this.get(principal, id)
      } catch (error) {
        if (submitted) {
          // A timeout, cleanup failure or database error cannot make an external write retryable.
          await client.query("update harness_mcp_change_plans set status='uncertain',error=$2 where id=$1 and status='submitting'", [id, 'The change may have been applied. Refresh the native configuration; this request will not be repeated.'])
          this.changed()
          return this.get(principal, id)
        }
        throw qualificationError(error)
      } finally {
        if (locked) {
          try { await client.query("select pg_advisory_unlock(hashtext('graphql:harness-mcp-settings'))") }
          catch { client.release(true); destroyed = true }
        }
        if (!destroyed) client.release()
      }
    })
  }
}
