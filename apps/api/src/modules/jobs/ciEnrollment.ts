import type pg from 'pg'
import { CiEnrollmentReadSchema, CiEnrollmentUpdateSchema, type CiEnrollmentComputer,
  type CiEnrollmentState, type CiEnrollmentTemplate, type CiInstalledStorage } from '@foreman-code/contracts'
import type { ManagementAction, ManagementPrincipal } from '@foreman-code/contracts/management'
import type { JobRuntimeProfileRecord } from '@foreman-code/contracts/job-verification-runtime'
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
import { ciEnrollmentDisabled, lockCiEnrollment } from './ciEnrollmentInventory.js'
import { ciEnrollmentProfileInput, ciEnrollmentTemplateDigest, requireCiEnrollmentStorage } from './ciEnrollmentProfiles.js'
import { JobOwnership } from './ownership.js'
import { canonical, jobDigest } from './digest.js'
import type { JobSql } from './repository.js'
import { lockActiveWorkspace } from '../workspaces/admission.js'

export const CI_ENROLLMENT_ACTIONS: ManagementAction[] = [
  ...CI_PREPARATION_ACTIONS, 'workspace_locations:validate', 'workspace_locations:update',
]
type Profiles = Pick<JobRuntimeProfiles, 'list' | 'save'>
type Preparation = Pick<CiRuntimeProvisioner, 'start' | 'get'>
const templateSetupRequired = {
  state: 'templates-required' as const,
  message: 'This workspace has no active CI runtime profiles. Save a verification profile with '
    + 'job_runtime_profile_save before automatic enrollment can prepare its build computers.',
}

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
    const listed = await this.profiles.list(principal, workspaceId)
    const hasTemplates = listed.profiles.some(row => row.profile.status !== 'revoked')
    const computers = (await this.inventory.computers()).map(computer => {
      const stored = saved.find(row => buildComputerKey(row.state.target) === buildComputerKey(computer.target))?.state
      const state = this.targetState(computer, stored)
      const setup = hasTemplates ? {} : templateSetupRequired
      return { ...state, ...setup, target: computer.target, ...this.availability(computer, state.enabled) }
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
        await lockCiEnrollment(sql, input.workspaceId, input.target)
        const row = (await sql.query<{ revision: string }>(
          'select revision from ci_enrollment_computers where workspace_id=$1 and host_key=$2 for update',
          [input.workspaceId, key])).rows[0]
        if (Number(row?.revision ?? 0) !== input.expectedRevision) {
          throw new DomainError('REVISION_CONFLICT', 'CI enrollment changed. Refresh before saving again.', 409)
        }
        const state: CiEnrollmentComputer = { target: input.target, revision: input.expectedRevision + 1,
          enabled: input.enabled, state: input.enabled ? 'pending' : 'disabled', profileIds: [], templates: [], message: null,
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
    return { target: computer.target, revision: 0, enabled: true, state: 'pending', profileIds: [], templates: [],
      message: null, updatedAt: null }
  }

  private targetState(computer: CiEnrollmentTarget, state?: CiEnrollmentComputer): CiEnrollmentComputer {
    if (!state) return this.initial(computer)
    if (canonical(state.target) === canonical(computer.target)) return state
    return { ...this.initial(computer), revision: state.revision, enabled: state.enabled }
  }

  private availability(computer: CiEnrollmentTarget, enabled: boolean): Partial<CiEnrollmentComputer> {
    if (!enabled || !computer.buildEnabled) return { state: 'disabled' }
    if (!computer.connected) return { state: 'offline' }
    return {}
  }

  private async enroll(principal: ManagementPrincipal, workspaceId: string, computer: CiEnrollmentTarget,
    templates: JobRuntimeProfileRecord[], record: CiEnrollmentRecord): Promise<void> {
    record.state = { ...this.targetState(computer, record.state), target: computer.target, message: null, state: 'pending',
      ...this.availability(computer, record.state.enabled), updatedAt: new Date().toISOString() }
    if (record.state.state !== 'pending') {
      await this.repository.save(this.pool, workspaceId, record)
      return
    }
    record.state.profileIds = []
    record.state.templates = templates.map<CiEnrollmentTemplate>(template => ({
      templateId: template.id, profileId: null,
      state: template.schemaVersion === 1 ? 'not-enrolled-automatically' : 'pending',
      message: template.schemaVersion === 1
        ? 'Ordinary Job templates are not enrolled automatically; configure and qualify their protected runtime explicitly.'
        : null,
    }))
    try {
      const verification = templates.filter(template => template.schemaVersion === 2)
      const runtime = this.inventory.runtimeStatus
        ? await this.inventory.runtimeStatus(computer.target) : undefined
      if (runtime?.managedSetup) record.state.managedSetup = runtime.managedSetup
      else if (runtime !== undefined) delete record.state.managedSetup
      let storage: CiInstalledStorage | null = null
      if (verification.length) {
        storage = runtime === undefined
          ? await this.inventory.storage(computer.target) : runtime?.installedStorage ?? null
      }
      for (const template of verification) {
        if (await ciEnrollmentDisabled(this.pool, workspaceId, computer.target)) return
        const result = record.state.templates.find(value => value.templateId === template.id)!
        if (!storage) {
          result.state = 'runtime-required'
          result.message = runtime?.managedSetup?.message
            ?? 'An installed verification runtime is required for automatic enrollment.'
          continue
        }
        try {
          const link = await this.enrollProfile(principal, workspaceId, computer,
            template, storage, record.profiles[template.id])
          record.profiles[template.id] = link
          result.profileId = link.profileId
          record.state.profileIds = [...new Set([...record.state.profileIds, link.profileId])]
          await this.repository.save(this.pool, workspaceId, record)
          result.state = await this.prepareProfile(principal, workspaceId, link.profileId, record.state)
        } catch (error) {
          if (this.scopeFailure(error)) throw error
          result.state = this.failureState(error)
          result.message = (error instanceof Error ? error.message : 'CI profile enrollment failed.').slice(0, 2000)
          componentLogger('jobs').warn({ err: error, workspaceId, templateId: template.id,
            host: buildComputerKey(computer.target) }, 'CI profile enrollment is pending')
        }
      }
      this.summarize(templates, record.state)
    } catch (error) {
      const failure = this.failureState(error)
      record.state.state = failure
      record.state.message = (error instanceof Error ? error.message : 'CI enrollment failed.').slice(0, 2000)
      for (const result of record.state.templates.filter(value => value.state === 'pending')) {
        result.state = failure
        result.message = record.state.message
      }
      componentLogger('jobs').warn({ err: error, workspaceId, host: buildComputerKey(computer.target) },
        'CI computer enrollment is pending')
    }
    await this.repository.save(this.pool, workspaceId, record)
  }

  private scopeFailure(error: unknown): boolean {
    return error instanceof DomainError && (error.status === 403
      || ['CI_ENROLLMENT_OFFLINE', 'BUILD_COMPUTER_IDENTITY_CHANGED', 'WORKER_EXECUTION_DISABLED'].includes(error.code))
  }

  private failureState(error: unknown): CiEnrollmentTemplate['state'] {
    if (error instanceof DomainError) {
      if (error.code === 'CI_ENROLLMENT_ROOT_REQUIRED') return 'root-required'
      if (error.code === 'CI_ENROLLMENT_STORAGE_REQUIRED') return 'storage-required'
      if (error.code === 'CI_RUNTIME_BUSY') return 'pending'
    }
    return 'failed'
  }

  private summarize(templates: JobRuntimeProfileRecord[], state: CiEnrollmentComputer): void {
    const statuses = new Set(state.templates.map(result => result.state))
    if (!statuses.size) {
      Object.assign(state, templateSetupRequired)
      return
    }
    if (statuses.size === 1) state.state = state.templates[0]!.state
    else if ([...statuses].some(status => !['pending', 'preparing', 'ready'].includes(status))) state.state = 'partial'
    else state.state = statuses.has('preparing') ? 'preparing' : 'pending'
    const messages = state.templates.filter(result => result.message).map(result => {
      const template = templates.find(value => value.id === result.templateId)!
      return `${template.name}: ${result.message}`
    })
    state.message = messages.length ? messages.join('\n').slice(0, 2000) : null
  }

  private async enrollProfile(principal: ManagementPrincipal, workspaceId: string, computer: CiEnrollmentTarget,
    template: JobRuntimeProfileRecord, storage: CiInstalledStorage,
    link: CiEnrollmentRecord['profiles'][string] | undefined): Promise<{ profileId: string; digest: string }> {
    const current = await this.profiles.list(principal, workspaceId)
    requireCiEnrollmentStorage(template, storage)
    const templateDigest = ciEnrollmentTemplateDigest(template)
    const digest = jobDigest({ template: templateDigest, installation: computer.target })
    let profile = current.profiles.find(row => row.profile.id === link?.profileId)?.profile
    if (profile?.status === 'revoked') {
      throw new DomainError('JOB_RUNTIME_PROFILE_REVOKED', 'The enrolled CI profile was revoked.', 409)
    }
    const sameHost = buildComputerKey({ hostRef: template.root.selection.hostRef }) === buildComputerKey(computer.target)
      && (computer.target.hostRef.kind === 'main'
        || template.root.binding.workerInstallationId === computer.target.applicationInstallationId
          && template.root.registration?.keyRevision === computer.target.keyRevision
          && template.root.registration?.authorizationRevision === computer.target.authorizationRevision)
    if (sameHost && (!profile || profile.id === template.id)) return { profileId: template.id, digest }
    if (profile && link?.digest === digest && profile.id !== template.id
      && ciEnrollmentTemplateDigest(profile) === templateDigest) return { profileId: profile.id, digest }
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

  private async prepareProfile(principal: ManagementPrincipal, workspaceId: string, profileId: string,
    enrollment: Pick<CiEnrollmentComputer, 'target' | 'revision'>): Promise<CiEnrollmentTemplate['state']> {
    const { profile, ready } = (await this.profiles.list(principal, workspaceId)).profiles
      .find(row => row.profile.id === profileId)!
    if (profile.schemaVersion !== 2 || profile.status === 'revoked') {
      throw new DomainError('JOB_RUNTIME_PROFILE_REVOKED', 'The enrolled CI profile is unavailable.', 409)
    }
    if (ready) return 'ready'
    if (await ciEnrollmentDisabled(this.pool, workspaceId, enrollment.target)) return 'pending'
    const progress = await this.preparation.get(principal, { workspaceId, profileId })
    if (['idle', 'qualified', 'failed'].includes(progress.state)) {
      const commandId = `enroll-prepare-${jobDigest({ workspaceId, id: profile.id, revision: profile.revision,
        measurement: profile.measurement, enrollmentRevision: enrollment.revision,
        previousPreparation: progress.startedAt })}`
      await this.preparation.start(principal, 'mcp', { workspaceId, profileId, commandId,
        ...(profile.sourceCommit ? { commit: profile.sourceCommit } : {}) })
      return 'preparing'
    }
    return progress.profileId === profileId || progress.profiles.some(value => value.profileId === profileId)
      ? 'preparing' : 'pending'
  }
}
