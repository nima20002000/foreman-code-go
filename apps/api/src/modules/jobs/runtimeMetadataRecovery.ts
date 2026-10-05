import type pg from 'pg'
import { JobRuntimeProfileSchema, type JobRuntimeProfile } from '@graphql/contracts/job-runtime'
import { componentLogger } from '../../infrastructure/logger.js'
import type { InstalledJobRuntimeHost } from './runtimeProfileFactory.js'

/** Restores inspected metadata without creating or extending qualification. */
export class JobRuntimeMetadataRecovery {
  private readonly captures = new Map<string, Promise<void>>()
  private scan: Promise<void> | undefined
  private closing = false

  constructor(private readonly pool: pg.Pool, private readonly host: InstalledJobRuntimeHost,
    private readonly changed: () => void) {}

  request(): void {
    if (this.closing || this.scan) return
    this.scan = this.pool.query<{ record: unknown }>(`select record from job_runtime_profiles
      where record->>'status'='qualified'
      union all select v.record || jsonb_build_object('status','qualified','measurement',a.measurement)
        from job_runtime_profile_versions v join job_runtime_qualification_approvals a
          on a.profile_id=v.profile_id and a.profile_revision=v.revision
        join job_runtime_profiles p on p.id=v.profile_id
        where a.record->>'status'='complete' and p.record->>'status'<>'revoked'`)
      .then(result => {
        for (const row of result.rows) {
          const profile = JobRuntimeProfileSchema.parse(row.record)
          if (!profile.measurement || Date.parse(profile.measurement.expiresAt) <= Date.now()) continue
          const key = `${profile.id}:${profile.revision}`
          if (this.captures.has(key)) continue
          const capture = this.refresh(profile).then(refreshed => {
            if (refreshed && !this.closing) this.changed()
          }).catch(error => {
            componentLogger('jobs').warn({ err: error, profileId: profile.id }, 'Job runtime inspection unavailable')
          }).finally(() => { this.captures.delete(key) })
          this.captures.set(key, capture)
        }
      }).catch(error => {
        componentLogger('jobs').error({ err: error }, 'Job runtime metadata recovery failed')
      }).finally(() => { this.scan = undefined })
  }

  private async refresh(profile: JobRuntimeProfile): Promise<boolean> {
    if (await this.host.currentMetadata(this.pool, profile)) return false
    if (this.host.capture) await this.host.capture(profile)
    else await this.host.descriptor(profile)
    // Runtime readiness still compares this inspected fingerprint with the retained measurement.
    return true
  }

  async refreshExecution(executionId: string): Promise<void> {
    const row = (await this.pool.query<{ record: unknown }>(`select v.record from job_executions e
      join job_runtime_profile_versions v on v.profile_id=e.accepted_spec #>> '{policy,isolationPolicyId}'
        and v.revision=(e.accepted_spec #>> '{policy,isolationPolicyRevision}')::bigint
      where e.id=$1`, [executionId])).rows[0]
    if (row) await this.refresh(JobRuntimeProfileSchema.parse(row.record))
  }

  async close(): Promise<void> {
    this.closing = true
    await this.scan
    await Promise.all([...this.captures.values()])
  }
}
