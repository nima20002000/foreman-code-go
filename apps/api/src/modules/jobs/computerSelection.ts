import {
  isAutoJobSpec, ResolvedJobDefinitionSpecSchema, JobComputerSelectionSchema,
  jobPolicyRequirements,
  type JobDefinition, type JobDefinitionSpec, type ResolvedJobDefinitionSpec,
  type PreparedJobSpec,
} from '@graphql/contracts/jobs'
import type { JobRuntimeProfile } from '@graphql/contracts/job-runtime'
import { DEVICE_RESOURCE_CONTROL_RESERVE } from '@graphql/contracts/device-resources'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import type { BuildComputerPreference } from '@graphql/contracts/build-computers'
import { type BuildComputerSettings, buildComputerKey, buildComputerTarget } from '../settings/buildComputers.js'
import type { WorkerExecutionPolicy } from '../settings/workerExecution.js'
import { DomainError } from '../errors.js'
import { canonical, type JobSql } from './repository.js'
import { SOURCE_AGGREGATE_LIMITS } from '../sources/reservations.js'
import { JobComputerEligibilityReasonSchema, type JobComputerEligibility } from '@graphql/contracts/job-admission'

export interface JobPreparationIdentity { executionId: string; attemptId: string; operationId: string }
export interface JobComputerCandidate {
  spec: ResolvedJobDefinitionSpec
  profile: JobRuntimeProfile
  ready: boolean
  reasons: string[]
  sourceReservation: { scopeId: string; reservedBytes: number }
}
export interface JobComputerInventory {
  candidates(sql: JobSql, principal: ManagementPrincipal, workspaceId: string,
    spec: JobDefinitionSpec): Promise<JobComputerCandidate[]>
}
type EnrolledCandidate = JobComputerCandidate & { preference: BuildComputerPreference }
export interface JobComputerClaim {
  spec: ResolvedJobDefinitionSpec | null
  compatibleTargetCount: number
  reasons: JobComputerEligibility['reasons']
  diagnosticCodes: string[]
  waitingHosts: string[]
  selectedHost: string | null
  exceedsMaximum: boolean
}
export function jobEligibilityReason(code: string): JobComputerEligibility['reasons'][number] {
  const known = JobComputerEligibilityReasonSchema.safeParse(code)
  if (known.success) return known.data
  if (['AUTH_REVOKED', 'AUTH_INVALID', 'revoked', 'unauthorized', 'forbidden', 'ACCESS_DENIED'].includes(code)) {
    return 'authorization_revoked'
  }
  if (code === 'BUILD_COMPUTER_DISABLED') return 'disabled'
  if (code === 'WORKER_EXECUTION_DISABLED') return 'remote_execution_disabled'
  if (code === 'JOB_ROOT_PIN_CONFLICT' || code === 'SOURCE_ROOT_NOT_FOUND') return 'root_changed'
  if (code === 'JOB_SOURCE_PIN_CONFLICT') return 'source_unavailable'
  if (code === 'JOB_RUNTIME_UNQUALIFIED') return 'runtime_unqualified'
  if (code === 'JOB_RUNTIME_CONTEXT_CHANGED') return 'runtime_unqualified'
  return 'eligibility_check_failed'
}
export function compatibleJobComputer(candidate: JobComputerCandidate, request: JobDefinitionSpec): boolean {
  const common = (spec: JobDefinitionSpec) => ({ source: spec.source, argv: spec.argv,
    inputs: spec.inputs, outputs: spec.outputs, relativeCwd: spec.relativeCwd ?? null })
  if (canonical(common(candidate.spec)) !== canonical(common(request))) return false
  if (!isAutoJobSpec(request)) return canonical(candidate.spec) === canonical(request)
  return canonical(jobPolicyRequirements(candidate.spec.policy)) === canonical(request.policy)
    && canonical(candidate.profile.limits) === canonical(request.limits)
}
export function orderBuildComputers(candidates: EnrolledCandidate[]): EnrolledCandidate[] {
  return candidates.filter(candidate => candidate.ready && candidate.preference.buildEnabled).sort((left, right) => {
    const priority = right.preference.buildPriority - left.preference.buildPriority
    if (priority) return priority
    const leftKey = `${buildComputerKey(left.preference.target)}:${left.profile.root.binding.rootId}:${left.profile.id}`
    const rightKey = `${buildComputerKey(right.preference.target)}:${right.profile.root.binding.rootId}:${right.profile.id}`
    if (leftKey < rightKey) return -1
    if (leftKey > rightKey) return 1
    return 0
  })
}
export function jobComputerCapacity(profile: JobRuntimeProfile): JobRuntimeProfile['limits'] {
  const runtime = profile.measurement?.runtime
  if (!runtime?.deviceLimits || !runtime.quota) return profile.limits
  const allowance = runtime.deviceLimits
  const reserve = DEVICE_RESOURCE_CONTROL_RESERVE
  return { cpuLimit: allowance.cpuLimit - reserve.cpuLimit,
    memoryBytes: allowance.memoryBytes - reserve.memoryBytes,
    pidsLimit: allowance.pidsLimit - reserve.pidsLimit,
    diskBytes: Math.min(allowance.diskBytes - reserve.diskBytes, runtime.quota.workloadHardLimitBytes) }
}

const closedJobComputerSql = `(
      exists(select 1 from job_executions e join source_execution_materializations m on m.operation_id=e.operation_id
        where e.id=s.execution_id and m.state='closed' and e.record #>> '{process,phase}'='terminal'
        and e.record #> '{process,processStopped}'='true'::jsonb
        and e.record->>'publication' not in ('pending','collecting'))
      or exists(select 1 from source_preparation_reconciliations c
        where c.operation_id=s.operation_id and c.status='closed' and c.closure is not null
        and not exists(select 1 from job_executions e where e.id=s.execution_id)))`

/** Releases only closed source owners; offline or uncertain delivery retains capacity. */
export async function releaseClosedJobComputers(sql: JobSql): Promise<void> {
  await sql.query(`update job_computer_selections s set released_at=clock_timestamp()
    where s.released_at is null and ${closedJobComputerSql}`)
}
export async function readJobComputerSelection(sql: JobSql, definition: JobDefinition,
  identity: JobPreparationIdentity): Promise<ResolvedJobDefinitionSpec> {
  const row = (await sql.query<{ spec: unknown; definition_version_id: string; attempt_id: string; operation_id: string }>(
    'select spec,definition_version_id,attempt_id,operation_id from job_computer_selections where execution_id=$1 and workspace_id=$2 for share',
    [identity.executionId, definition.workspaceId])).rows[0]
  if (!row) {
    if (isAutoJobSpec(definition.spec)) {
      throw new DomainError('JOB_COMPUTER_SELECTION_MISSING', 'The original Auto computer selection is missing.', 409)
    }
    return definition.spec
  }
  if (row.definition_version_id !== definition.versionId || row.attempt_id !== identity.attemptId
    || row.operation_id !== identity.operationId) {
    throw new DomainError('JOB_COMPUTER_SELECTION_CONFLICT', 'This selection belongs to another Job preparation.', 409)
  }
  return ResolvedJobDefinitionSpecSchema.parse(row.spec)
}

export class JobComputerSelection {
  constructor(private readonly settings: BuildComputerSettings, private readonly inventory: JobComputerInventory,
    private readonly workerExecution: WorkerExecutionPolicy) {}

  async reserve(sql: JobSql, principal: ManagementPrincipal, definition: JobDefinition,
    identity: JobPreparationIdentity): Promise<ResolvedJobDefinitionSpec> {
    const claim = await this.claim(sql, principal, definition, identity)
    if (claim.spec) return claim.spec
    const code = isAutoJobSpec(definition.spec) ? 'JOB_NO_BUILD_COMPUTER' : 'JOB_BUILD_COMPUTER_UNAVAILABLE'
    throw new DomainError(code, 'No eligible build computer. Enable builds and check connection, runtime setup and capacity.',
      409, { reasons: claim.reasons, diagnosticCodes: claim.diagnosticCodes })
  }

  async claim(sql: JobSql, principal: ManagementPrincipal, definition: JobDefinition,
    identity: JobPreparationIdentity, excludedHosts: ReadonlySet<string> = new Set()): Promise<JobComputerClaim> {
    const prior = (await sql.query('select 1 from job_computer_selections where execution_id=$1', [identity.executionId])).rowCount
    if (prior) {
      const spec = await readJobComputerSelection(sql, definition, identity)
      return { spec, compatibleTargetCount: 1, reasons: [], diagnosticCodes: [], waitingHosts: [],
        selectedHost: buildComputerKey(buildComputerTarget(spec.target)), exceedsMaximum: false }
    }
    const candidates = await this.inventory.candidates(sql, principal, definition.workspaceId, definition.spec)
    const enrolled: EnrolledCandidate[] = []
    const reasons: string[] = []
    for (const candidate of candidates) {
      if (!compatibleJobComputer(candidate, definition.spec)) {
        reasons.push('incompatible')
        continue
      }
      const preference = await this.settings.preference(sql, buildComputerTarget(candidate.spec.target))
      enrolled.push({ ...candidate, preference })
      if (!preference.buildEnabled) reasons.push('disabled')
      reasons.push(...candidate.reasons)
    }
    const compatibleTargetCount = new Set(enrolled.map(candidate => buildComputerKey(candidate.preference.target))).size
    const maximumCandidates = enrolled.filter(candidate => this.fitsEmptyComputer(candidate))
    const exceedsMaximum = enrolled.length > 0 && maximumCandidates.length === 0
    const waitingHosts: string[] = []
    for (const candidate of orderBuildComputers(enrolled)) {
      if (!this.fitsEmptyComputer(candidate)) {
        reasons.push('request_exceeds_maximum')
        continue
      }
      try { this.workerExecution.requireEnabled(candidate.spec.target.hostRef) } catch (error) {
        if (!(error instanceof DomainError) || error.code !== 'WORKER_EXECUTION_DISABLED') throw error
        reasons.push('remote_execution_disabled')
        continue
      }
      const preference = await this.settings.requireEnabled(sql, buildComputerTarget(candidate.spec.target))
      const hostKey = buildComputerKey(preference.target)
      waitingHosts.push(hostKey)
      if (excludedHosts.has(hostKey)) {
        reasons.push('busy')
        continue
      }
      await sql.query('select pg_advisory_xact_lock(hashtext($1))', [`job-capacity:${hostKey}`])
      await sql.query('select pg_advisory_xact_lock(hashtext($1))', [`source-storage:${candidate.sourceReservation.scopeId}`])
      await releaseClosedJobComputers(sql)
      if (!await this.fits(sql, candidate)) {
        reasons.push('busy')
        continue
      }
      const selection = { mode: isAutoJobSpec(definition.spec) ? 'auto' : 'fixed',
        buildPriority: preference.buildPriority, settingsRevision: preference.revision }
      await sql.query(`insert into job_computer_selections
        (execution_id,workspace_id,definition_version_id,attempt_id,operation_id,host_key,spec,limits,selection,source_scope,source_bytes)
        values($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11)`,
      [identity.executionId, definition.workspaceId, definition.versionId, identity.attemptId, identity.operationId,
        hostKey, JSON.stringify(candidate.spec), JSON.stringify(candidate.profile.limits), JSON.stringify(selection),
        candidate.sourceReservation.scopeId, candidate.sourceReservation.reservedBytes])
      return { spec: candidate.spec, compatibleTargetCount, reasons: [], diagnosticCodes: [], waitingHosts: [],
        selectedHost: hostKey, exceedsMaximum: false }
    }
    const diagnosticCodes = [...new Set(reasons.length ? reasons : ['setup_required'])]
    const normalized = diagnosticCodes.map(jobEligibilityReason)
      .filter(reason => reason !== 'request_exceeds_maximum' || exceedsMaximum)
    return { spec: null, compatibleTargetCount, diagnosticCodes, waitingHosts: [...new Set(waitingHosts)],
      selectedHost: null, exceedsMaximum, reasons: [...new Set(normalized)] }
  }
  private fitsEmptyComputer(candidate: JobComputerCandidate): boolean {
    const capacity = jobComputerCapacity(candidate.profile)
    if (candidate.sourceReservation.reservedBytes > SOURCE_AGGREGATE_LIMITS.bytes) return false
    return (Object.keys(capacity) as (keyof typeof capacity)[])
      .every(field => candidate.profile.limits[field] <= capacity[field])
  }
  private async fits(sql: JobSql, candidate: JobComputerCandidate): Promise<boolean> {
    const storage = (await sql.query<{ bytes: string; materializations: string }>(`select coalesce(sum(bytes),0)::text as bytes,
      coalesce(sum(materializations),0)::text as materializations from (
        select reserved_bytes as bytes, case when owner_kind='materialization' and state in ('preparing','owned','uncertain')
          then 1 else 0 end as materializations from source_storage_reservations where scope_id=$1 and state<>'reclaimed'
        union all select source_bytes,1 from job_computer_selections s where s.source_scope=$1 and s.released_at is null
          and not exists(select 1 from source_storage_reservations r where r.owner_kind='materialization' and r.owner_id=s.operation_id)
      ) usage`, [candidate.sourceReservation.scopeId])).rows[0]!
    if (Number(storage.bytes) + candidate.sourceReservation.reservedBytes > SOURCE_AGGREGATE_LIMITS.bytes
      || Number(storage.materializations) >= SOURCE_AGGREGATE_LIMITS.materializations) return false
    return jobComputerHasCapacity(sql, candidate.spec.target, candidate.profile)
  }

  async prepare(sql: JobSql, definition: JobDefinition, identity: JobPreparationIdentity): Promise<ResolvedJobDefinitionSpec> {
    const spec = await readJobComputerSelection(sql, definition, identity)
    this.workerExecution.requireEnabled(spec.target.hostRef)
    await this.settings.requireEnabled(sql, buildComputerTarget(spec.target))
    const row = (await sql.query<{ released_at: Date | null }>(
      'select released_at from job_computer_selections where execution_id=$1', [identity.executionId])).rows[0]
    if (!row || row.released_at) throw new DomainError('JOB_PREPARATION_CLOSED', 'This preparation was closed; create a new Start command.', 409)
    return spec
  }
  async selection(sql: JobSql, identity: JobPreparationIdentity): Promise<PreparedJobSpec['computerSelection']> {
    const row = (await sql.query<{ selection: unknown }>(
      'select selection from job_computer_selections where execution_id=$1 and attempt_id=$2 and operation_id=$3',
      [identity.executionId, identity.attemptId, identity.operationId])).rows[0]
    return row ? JobComputerSelectionSchema.parse(row.selection) : undefined
  }
  async validateFixed(sql: JobSql, spec: ResolvedJobDefinitionSpec) {
    try {
      this.workerExecution.requireEnabled(spec.target.hostRef)
      await this.settings.requireEnabled(sql, buildComputerTarget(spec.target))
      return { valid: true, reasons: [], sideEffects: false as const }
    } catch (error) {
      if (!(error instanceof DomainError)
        || !['BUILD_COMPUTER_DISABLED', 'WORKER_EXECUTION_DISABLED'].includes(error.code)) throw error
      return { valid: false, reasons: [error.message], sideEffects: false as const }
    }
  }
}

export async function jobComputerHasCapacity(sql: JobSql,
  target: Pick<ResolvedJobDefinitionSpec['target'], 'mainId' | 'hostRef'>, profile: JobRuntimeProfile): Promise<boolean> {
  const hostKey = buildComputerKey({ hostRef: target.hostRef })
  const rows = (await sql.query<{ limits: JobRuntimeProfile['limits'] }>(`select limits from job_computer_selections s
    where host_key=$1 and released_at is null and not ${closedJobComputerSql}
    union all select (p.record->'limits') as limits from job_executions e
    join job_runtime_profile_versions p on p.profile_id=e.accepted_spec #>> '{policy,isolationPolicyId}'
      and p.revision=(e.accepted_spec #>> '{policy,isolationPolicyRevision}')::bigint
    where not exists(select 1 from job_computer_selections s where s.execution_id=e.id)
      and e.accepted_spec #>> '{target,hostRef,mainId}'=$2
      and coalesce(e.accepted_spec #>> '{target,hostRef,deviceId}','main')=$3
      and (e.record #>> '{process,phase}'<>'terminal' or e.record #> '{process,processStopped}'<>'true'::jsonb)`,
  [hostKey, target.mainId,
    target.hostRef.kind === 'device' ? target.hostRef.deviceId : 'main'])).rows
  const capacity = jobComputerCapacity(profile)
  // Build qualification starts with one heavy slot; storage stays charged through publication and cleanup.
  if (rows.length >= 1) return false
  return (Object.keys(capacity) as (keyof typeof capacity)[]).every(field =>
    rows.reduce((total, row) => total + row.limits[field], profile.limits[field]) <= capacity[field])
}

export async function releaseUnstartedJobComputer(sql: JobSql, identity: JobPreparationIdentity): Promise<void> {
  await sql.query(`update job_computer_selections s set released_at=clock_timestamp()
    where execution_id=$1 and attempt_id=$2 and operation_id=$3 and released_at is null
      and not exists(select 1 from job_executions e where e.id=s.execution_id)
      and not exists(select 1 from source_storage_reservations r where r.owner_kind='materialization' and r.owner_id=s.operation_id)
      and not exists(select 1 from source_execution_materializations m where m.operation_id=s.operation_id)`,
  [identity.executionId, identity.attemptId, identity.operationId])
}
