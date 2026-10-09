import type pg from 'pg'
import { CiEnrollmentReadSchema, CiEnrollmentUpdateSchema, type CiEnrollmentComputer,
  type CiEnrollmentState, type CiInstalledStorage } from '@foreman-code/contracts'
import type { ManagementAction, ManagementPrincipal } from '@foreman-code/contracts/management'
import { jobRuntimeProfileLimits, type JobRuntimeProfileRecord } from '@foreman-code/contracts/job-verification-runtime'
import { intersectGrants } from '../access/operatorDelegation.js'
import { currentOperatorAuthority } from '../access/runAuthority.js'
import { isAuthorized, requireAuthorization } from '../access/policy.js'
import { assertBuildComputerTarget, buildComputerKey } from '../settings/buildComputers.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { componentLogger } from '../diagnostics/logger.js'
import { DomainError } from '../errors.js'
import { CI_PREPARATION_ACTIONS } from './ciAuthority.js'
import type { CiRuntimeProvisioner } from './ciRuntimeProvisioner.js'
import type { JobRuntimeProfiles } from './runtimeProfiles.js'
import { CiEnrollmentRepository, type CiEnrollmentRecord } from './ciEnrollmentRepository.js'
import type { CiEnrollmentInventory, CiEnrollmentTarget } from './ciEnrollmentInventory.js'
import { ciEnrollmentDisabled } from './ciEnrollmentInventory.js'
import { ciEnrollmentProfileInput, ciEnrollmentTemplateDigest } from './ciEnrollmentProfiles.js'
import { JobOwnership } from './ownership.js'
import { jobDigest } from './digest.js'
import type { JobSql } from './repository.js'
import { lockActiveWorkspace } from '../workspaces/admission.js'

export const CI_ENROLLMENT_ACTIONS: ManagementAction[] = [...CI_PREPARATION_ACTIONS]
type Profiles = Pick<JobRuntimeProfiles, 'list' | 'save' | 'requestQualification' | 'qualify'>
type Preparation = Pick<CiRuntimeProvisioner, 'start' | 'get'>

export class CiEnrollment {
  private readonly repository: CiEnrollmentRepository
  private pending: Promise<void> | undefined
  private requested = false
  private closed = false

  constructor(private readonly pool: pg.Pool, private readonly commands: PostgresCommandCoordinator,
    private readonly profiles: Profiles, private readonly preparation: Preparation,
    private readonly inventory: CiEnrollmentInventory) {
    this.repository = new CiEnrollmentRepository(pool)
  }

  private async authorize(principal: ManagementPrincipal, workspaceId: string, actions: ManagementAction[],
    sql: JobSql = this.pool): Promise<ManagementPrincipal> {
    for (const action of actions) requireAuthorization(principal, action, { workspaceId })
    const live = (await currentOperatorAuthority(sql, principal.id)).principal
    const accepted = { ...principal, grants: intersectGrants(principal.grants, live.grants),
      expiresAt: new Date(Math.min(Date.parse(principal.expiresAt), Date.parse(live.expiresAt))).toISOString() }
    for (const action of actions) requireAuthorization(accepted, action, { workspaceId })
    return accepted
  }

  async profileSaved(principal: ManagementPrincipal, workspaceId: string): Promise<void> {
    if (!CI_ENROLLMENT_ACTIONS.every(action => isAuthorized(principal, action, { workspaceId }))) return
    try {
      const accepted = await this.authorize(principal, workspaceId, CI_ENROLLMENT_ACTIONS)
      await this.repository.workspace(this.pool, workspaceId, accepted)
    } catch (error) {
      if (!(error instanceof DomainError) || (!error.code.startsWith('AUTH_') && error.code !== 'ACCESS_DENIED')) {
        throw error
      }
      // Enrollment authority can expire after the profile save commits.
      componentLogger('jobs').warn({ err: error, workspaceId }, 'CI enrollment needs an authorized owner')
      return
    }
    this.request()
  }

  request(): void {
    if (this.closed) return
    this.requested = true
    if (this.pending) return
    this.pending = (async () => {
      while (this.requested && !this.closed) {
        this.requested = false
        await this.reconcile()
      }
    })().catch(error => componentLogger('jobs').error({ err: error }, 'Automatic CI enrollment failed'))
      .finally(() => { this.pending = undefined })
  }

  async close(): Promise<void> {
    this.closed = true
    await this.pending
  }

  async read(principal: ManagementPrincipal, raw: unknown): Promise<CiEnrollmentState> {
    const { workspaceId } = CiEnrollmentReadSchema.parse(raw)
    await this.authorize(principal, workspaceId, ['job_definitions:read'])
    const saved = await this.repository.computers(workspaceId)
    const computers = (await this.inventory.computers()).map(computer => {
      const state = saved.find(row => buildComputerKey(row.state.target) === buildComputerKey(computer.target))?.state
        ?? this.initial(computer)
      return { ...state, target: computer.target, ...this.availability(computer, state.enabled) }
    })
    return { workspaceId, computers }
  }

  async update(principal: ManagementPrincipal, source: 'http' | 'mcp', raw: unknown): Promise<CiEnrollmentState> {
    const input = CiEnrollmentUpdateSchema.parse(raw)
    try { await this.authorize(principal, input.workspaceId, CI_ENROLLMENT_ACTIONS) }
    catch (error) {
      await this.commands.recordDenied(principal.id, source, 'ci_enrollment_update', `workspace:${input.workspaceId}`)
      throw error
    }
    await this.commands.execute({ principal, source, commandId: input.commandId, operation: 'ci_enrollment_update',
      targetKey: input.workspaceId, payload: input,
      authorize: async sql => {
        await this.authorize(principal, input.workspaceId, CI_ENROLLMENT_ACTIONS, sql)
        await lockActiveWorkspace(sql, input.workspaceId)
        await assertBuildComputerTarget(sql, input.target)
      },
      perform: async sql => {
        const key = buildComputerKey(input.target)
        await sql.query('select pg_advisory_xact_lock(hashtext($1))', [`ci-enrollment:${input.workspaceId}:${key}`])
        const row = (await sql.query<{ revision: string }>(
          'select revision from ci_enrollment_computers where workspace_id=$1 and host_key=$2 for update',
          [input.workspaceId, key])).rows[0]
        if (Number(row?.revision ?? 0) !== input.expectedRevision) {
          throw new DomainError('REVISION_CONFLICT', 'CI enrollment changed. Refresh before saving again.', 409)
        }
        const state: CiEnrollmentComputer = { target: input.target, revision: input.expectedRevision + 1,
          enabled: input.enabled, state: input.enabled ? 'pending' : 'disabled', profileIds: [], message: null,
          updatedAt: new Date().toISOString() }
        await sql.query(`insert into ci_enrollment_computers(workspace_id,host_key,revision,enabled,state)
          values($1,$2,$3,$4,$5::jsonb) on conflict(workspace_id,host_key) do update
          set revision=excluded.revision,enabled=excluded.enabled,state=excluded.state`,
        [input.workspaceId, key, state.revision, input.enabled, JSON.stringify(state)])
        await this.repository.workspace(sql, input.workspaceId, principal)
        return { revision: state.revision }
      } })
    this.request()
    return this.read(principal, { workspaceId: input.workspaceId })
  }

  async reconcile(): Promise<void> {
    await this.registerExistingWorkspaces()
    for (const workspace of await this.repository.workspaces()) {
      if (this.closed) return
      const owner = await JobOwnership.acquire(this.pool, `ci-enrollment:${workspace.workspaceId}`, () => {})
      if (!owner) continue
      try {
        const principal = await this.authorize(workspace.principal, workspace.workspaceId, CI_ENROLLMENT_ACTIONS)
        const saved = await this.repository.computers(workspace.workspaceId)
        const listed = await this.profiles.list(principal, workspace.workspaceId)
        const generated = new Set(saved.flatMap(row => Object.entries(row.profiles)
          .filter(([templateId, link]) => templateId !== link.profileId).map(([, link]) => link.profileId)))
        const templates = listed.profiles.map(row => row.profile)
          .filter(profile => profile.status !== 'revoked' && !generated.has(profile.id))
        for (const computer of await this.inventory.computers()) {
          owner.assertOwned()
          if (this.closed) return
          const record = saved.find(row => buildComputerKey(row.state.target) === buildComputerKey(computer.target))
            ?? { state: this.initial(computer), profiles: {} }
          await this.enroll(principal, workspace.workspaceId, computer, templates, record)
        }
      } catch (error) {
        componentLogger('jobs').warn({ err: error, workspaceId: workspace.workspaceId }, 'CI workspace enrollment is pending')
      } finally { await owner.release() }
    }
  }

  private async registerExistingWorkspaces(): Promise<void> {
    const registered = new Set<string>()
    for (const row of await this.repository.unregisteredWorkspaces()) {
      if (this.closed) return
      if (registered.has(row.workspace_id)) continue
      try {
        const live = (await currentOperatorAuthority(this.pool, row.principal_id)).principal
        const accepted = await this.authorize(live, row.workspace_id, CI_ENROLLMENT_ACTIONS)
        await this.repository.workspace(this.pool, row.workspace_id, accepted)
        registered.add(row.workspace_id)
      } catch (error) {
        componentLogger('jobs').warn({ err: error, workspaceId: row.workspace_id },
          'Existing CI profiles need an authorized enrollment owner')
      }
    }
  }

  private initial(computer: CiEnrollmentTarget): CiEnrollmentComputer {
    return { target: computer.target, revision: 0, enabled: true, state: 'pending', profileIds: [],
      message: null, updatedAt: null }
  }

  private availability(computer: CiEnrollmentTarget, enabled: boolean): Partial<CiEnrollmentComputer> {
    if (!enabled || !computer.buildEnabled) return { state: 'disabled' }
    if (!computer.connected) return { state: 'offline' }
    return {}
  }

  private async enroll(principal: ManagementPrincipal, workspaceId: string, computer: CiEnrollmentTarget,
    templates: JobRuntimeProfileRecord[], record: CiEnrollmentRecord): Promise<void> {
    record.state = { ...record.state, target: computer.target, message: null, state: 'pending',
      ...this.availability(computer, record.state.enabled), updatedAt: new Date().toISOString() }
    const activeProfileIds = () => templates.flatMap(template => {
      const link = record.profiles[template.id]
      return link ? [link.profileId] : []
    })
    record.state.profileIds = [...new Set(activeProfileIds())]
    try {
      if (record.state.state === 'pending') {
        const storage = await this.inventory.storage(computer.target)
        if (!storage) record.state.state = 'runtime-required'
        else {
          for (const template of templates) {
            if (await ciEnrollmentDisabled(this.pool, workspaceId, computer.target)) return
            record.profiles[template.id] = await this.enrollProfile(principal, workspaceId, computer,
              template, storage, record.profiles[template.id])
            record.state.profileIds = [...new Set(activeProfileIds())]
            await this.repository.save(this.pool, workspaceId, record)
          }
          await this.prepare(principal, workspaceId, record)
        }
      }
    } catch (error) {
      record.state.state = error instanceof DomainError && error.code === 'CI_ENROLLMENT_ROOT_REQUIRED'
        ? 'root-required' : 'failed'
      record.state.message = (error instanceof Error ? error.message : 'CI enrollment failed.').slice(0, 2000)
      componentLogger('jobs').warn({ err: error, workspaceId, host: buildComputerKey(computer.target) },
        'CI computer enrollment is pending')
    }
    await this.repository.save(this.pool, workspaceId, record)
  }

  private async enrollProfile(principal: ManagementPrincipal, workspaceId: string, computer: CiEnrollmentTarget,
    template: JobRuntimeProfileRecord, storage: CiInstalledStorage,
    link: CiEnrollmentRecord['profiles'][string] | undefined): Promise<{ profileId: string; digest: string }> {
    const current = await this.profiles.list(principal, workspaceId)
    const digest = jobDigest({ template: ciEnrollmentTemplateDigest(template), storage, installation: computer.target })
    let profile = current.profiles.find(row => row.profile.id === link?.profileId)?.profile
    if (profile?.status === 'revoked') {
      throw new DomainError('JOB_RUNTIME_PROFILE_REVOKED', 'The enrolled CI profile was revoked.', 409)
    }
    const sameHost = buildComputerKey({ hostRef: template.root.selection.hostRef }) === buildComputerKey(computer.target)
    const fitsStorage = jobRuntimeProfileLimits(template).diskBytes <= storage.diskBytes
      && (template.schemaVersion === 1 || template.spec.resources.mutableInodes <= storage.mutableInodes)
    if (sameHost && fitsStorage) return { profileId: template.id, digest }
    if (profile && link?.digest === digest && profile.id !== template.id) return { profileId: profile.id, digest }
    const root = sameHost ? template.root
      : await this.inventory.root(principal, workspaceId, template.root, computer.target)
    const previous = profile?.id === template.id ? undefined : profile
    const commandId = `enroll-profile-${jobDigest({ workspaceId, target: computer.target,
      templateId: template.id, digest, root: root.binding,
      previous: profile ? { id: profile.id, revision: profile.revision } : null })}`
    profile = await this.profiles.save(principal, 'mcp', workspaceId,
      ciEnrollmentProfileInput(template, root, storage, commandId, previous))
    return { profileId: profile.id, digest }
  }

  private async prepare(principal: ManagementPrincipal, workspaceId: string, record: CiEnrollmentRecord): Promise<void> {
    const profiles = (await this.profiles.list(principal, workspaceId)).profiles
      .filter(row => record.state.profileIds.includes(row.profile.id))
    record.state.state = profiles.length && profiles.every(row => row.ready) ? 'ready' : 'pending'
    for (const { profile, ready } of profiles) {
      if (ready || profile.status === 'revoked') continue
      if (await ciEnrollmentDisabled(this.pool, workspaceId, record.state.target)) return
      if (profile.schemaVersion === 1) {
        const commandId = `enroll-qualify-${jobDigest({ workspaceId, id: profile.id, revision: profile.revision,
          measurement: profile.measurement, enrollmentRevision: record.state.revision })}`
        const approval = await this.profiles.requestQualification(principal, 'mcp', workspaceId,
          { profileId: profile.id, expectedRevision: profile.revision, commandId })
        await this.profiles.qualify(principal, 'mcp', workspaceId, `${commandId}:run`, approval.id)
      } else {
        const progress = await this.preparation.get(principal, { workspaceId, profileId: profile.id })
        if (['idle', 'qualified', 'failed'].includes(progress.state)) {
          const commandId = `enroll-prepare-${jobDigest({ workspaceId, id: profile.id, revision: profile.revision,
            measurement: profile.measurement, enrollmentRevision: record.state.revision,
            previousPreparation: progress.startedAt })}`
          await this.preparation.start(principal, 'mcp', { workspaceId, profileId: profile.id, commandId,
            ...(profile.sourceCommit ? { commit: profile.sourceCommit } : {}) })
        }
        record.state.state = 'preparing'
        return
      }
    }
  }
}
