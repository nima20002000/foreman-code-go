import type pg from 'pg'
import { type CompatibilityHarness } from '@foreman-code/contracts'
import { HarnessQualificationSchema, type HarnessQualification } from '@foreman-code/contracts/harness-qualification'
import { HostHarnessProfileEvidenceSchema, type HostHarnessOverride } from '@foreman-code/contracts/harness-registry'

export class HarnessQualificationRepository {
  constructor(private readonly pool: pg.Pool) {}

  async list(): Promise<HarnessQualification[]> {
    const result = await this.pool.query('select * from harness_qualifications order by harness, version, started_at desc')
    return result.rows.map((row: Record<string, unknown>) => this.parse(row))
  }

  async find(harness: CompatibilityHarness, version: string, binarySha256: string, suiteRevision: string): Promise<HarnessQualification | null> {
    const result = await this.pool.query(
      'select * from harness_qualifications where harness=$1 and version=$2 and binary_sha256=$3 and suite_revision=$4',
      [harness, version, binarySha256, suiteRevision],
    )
    return result.rows[0] ? this.parse(result.rows[0] as Record<string, unknown>) : null
  }

  async findInstalled(target: HostHarnessOverride['target'], binarySha256: string,
    suiteRevision: string): Promise<HarnessQualification[]> {
    const result = await this.pool.query<{ record: unknown }>(`select record from harness_instance_profile_evidence
      where record->'target'=$3::jsonb
      and record->'completedNativeQualification'->'target'=$3::jsonb
      and record->'completedNativeQualification'->>'purpose'='explicit-host-qualification'
      and record->'completedNativeQualification'->'record'->>'binarySha256'=$1
      and record->'completedNativeQualification'->'record'->>'suiteRevision'=$2
      and record->'completedNativeQualification'->'record'->>'status'='qualified'
      and record->>'qualified'='true'
      order by created_at desc,check_id desc limit 1`, [binarySha256, suiteRevision, JSON.stringify(target)])
    return result.rows.map(row => HostHarnessProfileEvidenceSchema.parse(row.record).completedNativeQualification!.record)
  }

  async save(record: HarnessQualification, evidence: Record<string, unknown> = {}, client?: pg.ClientBase): Promise<void> {
    await (client ?? this.pool).query(`insert into harness_qualifications
      (harness, version, binary_sha256, suite_revision, profile, status, checks, evidence, failure_reason, started_at, checked_at)
      values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11)
      on conflict (harness, version, binary_sha256, suite_revision) do update set
      profile=excluded.profile, status=excluded.status, checks=excluded.checks, evidence=excluded.evidence,
      failure_reason=excluded.failure_reason, started_at=excluded.started_at, checked_at=excluded.checked_at`, [
      record.harness, record.version, record.binarySha256, record.suiteRevision, record.profile,
      record.status === 'qualified' ? 'passed' : record.status, JSON.stringify(record.checks), JSON.stringify(evidence),
      record.failureReason, record.startedAt, record.checkedAt,
    ])
  }

  private parse(row: Record<string, unknown>): HarnessQualification {
    return HarnessQualificationSchema.parse({
      harness: row.harness, version: row.version, binarySha256: row.binary_sha256,
      suiteRevision: row.suite_revision, profile: row.profile,
      status: row.status === 'passed' ? 'qualified' : row.status,
      checks: row.checks, failureReason: row.failure_reason,
      startedAt: row.started_at instanceof Date ? row.started_at.toISOString() : row.started_at,
      checkedAt: row.checked_at instanceof Date ? row.checked_at.toISOString() : row.checked_at,
    })
  }
}
