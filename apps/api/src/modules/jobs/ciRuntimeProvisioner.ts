import type pg from 'pg'
import { BuildComputerPrepareGetInputSchema, BuildComputerPrepareInputSchema, BuildComputerPrepareStatusSchema,
  CI_RUNTIME_NAMESPACE, CiRuntimeWorkerStateSchema, WorkspaceSchema, type BuildComputerPrepareInput,
  type BuildComputerPrepareStatus, type CiRuntimeRequest, type CiRuntimeWorkerState } from '@foreman-code/contracts'
import type { JobVerificationProfile } from '@foreman-code/contracts/job-verification-runtime'
import type { ManagementPrincipal, ManagementAction } from '@foreman-code/contracts/management'
import { requireAuthorization } from '../access/policy.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { ComputerAccountsEndpoint } from '../computers/accounts.js'
import { DomainError } from '../errors.js'
import type { PostgresSourceService } from '../sources/service.js'
import { canonical } from './digest.js'
import type { JobRuntimeProfiles } from './runtimeProfiles.js'

/** Everything the chain does in the caller's name: approve the commit, rebind the root, save and qualify profiles. */
export const BUILD_COMPUTER_PREPARE_ACTIONS: readonly ManagementAction[] = ['job_definitions:write', 'sources:approve',
  'sources:read', 'source_roots:bind', 'source_roots:read', 'workspace_locations:read', 'jobs:start', 'job_artifacts:read']
const PREPARE_LIMIT_MS = 3 * 60 * 60_000
const RESTART_LIMIT_MS = 15 * 60_000
type Profiles = Pick<JobRuntimeProfiles, 'list' | 'save' | 'requestQualification' | 'qualify'>
type Sources = Pick<PostgresSourceService, 'approveProject' | 'rootList' | 'bindRoot'>
type Source = 'http' | 'mcp'
type Status = Omit<BuildComputerPrepareStatus, 'updatedAt'>

/** Brings a build computer's CI runtime to a commit with no human step: the computer builds its offline seed
 * and image, Main moves its verification profiles to that commit and image, the computer refreshes its
 * protected configuration, and Main requalifies every profile on it. One chain per computer at a time. */
export class CiRuntimeProvisioner {
  private readonly runs = new Map<string, BuildComputerPrepareStatus>()
  constructor(
    private readonly pool: pg.Pool,
    private readonly profiles: Profiles,
    private readonly sources: Sources,
    private readonly endpoint: () => ComputerAccountsEndpoint | undefined,
    private readonly commands: PostgresCommandCoordinator,
    private readonly timing: { pollMs: number; wait(ms: number): Promise<void>; now(): Date } = {
      pollMs: 15_000, wait: ms => new Promise(resolve => { setTimeout(resolve, ms).unref?.() }), now: () => new Date() },
  ) {}

  async start(principal: ManagementPrincipal, source: Source, raw: BuildComputerPrepareInput): Promise<BuildComputerPrepareStatus> {
    const input = BuildComputerPrepareInputSchema.parse(raw)
    try {
      for (const action of BUILD_COMPUTER_PREPARE_ACTIONS) requireAuthorization(principal, action, { workspaceId: input.workspaceId })
    } catch (error) {
      await this.commands.recordDenied(principal.id, source, 'build_computer_prepare', `workspace:${input.workspaceId}`)
      throw error
    }
    const { profile, deviceId } = await this.target(principal, input.workspaceId, input.profileId)
    const key = `${input.workspaceId}:${deviceId}`
    const running = this.runs.get(key)
    if (running && !['qualified', 'failed'].includes(running.state)) return running
    const status = this.set(key, { profileId: profile.id, deviceId, state: 'approving', commit: input.commit ?? null,
      stage: null, message: null, profiles: [], startedAt: this.timing.now().toISOString() })
    await this.commands.recordAudit(principal.id, source, 'build_computer_prepare', `device:${deviceId}`, 'succeeded',
      { profileId: profile.id, commit: input.commit ?? null })
    void this.run(principal, source, key, input, profile, deviceId).catch(error => {
      const current = this.runs.get(key)!
      this.set(key, { ...current, state: 'failed', message: error instanceof Error ? error.message.slice(0, 2000) : 'Preparation failed.' })
    })
    return status
  }

  async get(principal: ManagementPrincipal, raw: { workspaceId: string; profileId: string }): Promise<BuildComputerPrepareStatus> {
    const input = BuildComputerPrepareGetInputSchema.parse(raw)
    requireAuthorization(principal, 'job_definitions:read', { workspaceId: input.workspaceId })
    const { profile, deviceId } = await this.target(principal, input.workspaceId, input.profileId)
    return this.runs.get(`${input.workspaceId}:${deviceId}`) ?? BuildComputerPrepareStatusSchema.parse({ profileId: profile.id,
      deviceId, state: 'idle', commit: null, stage: null, message: null, profiles: [], startedAt: null, updatedAt: null })
  }

  /** Starts a chain for every build computer whose profiles for `suite` were qualified on other dependency files. */
  async prepareForCommit(principal: ManagementPrincipal, workspaceId: string, suite: string, commit: string) {
    const listed = await this.profiles.list(principal, workspaceId)
    const devices = new Map<string, JobVerificationProfile>()
    for (const { profile } of listed.profiles) {
      if (profile.schemaVersion !== 2 || !profile.spec.suites.includes(suite as never) || profile.sourceCommit === commit) continue
      const hostRef = profile.root.selection.hostRef
      if (hostRef.kind === 'device' && !devices.has(hostRef.deviceId)) devices.set(hostRef.deviceId, profile)
    }
    for (const profile of devices.values()) {
      await this.start(principal, 'mcp', { workspaceId, profileId: profile.id, commit, commandId: `auto-${commit}-${profile.id}` })
        .catch(() => undefined)
    }
  }

  private async run(principal: ManagementPrincipal, source: Source, key: string, input: BuildComputerPrepareInput,
    profile: JobVerificationProfile, deviceId: string) {
    const update = (patch: Partial<Status>) => this.set(key, { ...this.runs.get(key)!, ...patch })
    const repository = await this.repository(input.workspaceId)
    const approved = await this.sources.approveProject(principal, { workspaceId: input.workspaceId,
      commandId: `${input.commandId}:source`, ...(input.commit ? { commit: input.commit } : {}) })
    const commit = approved.manifest.git!.commit
    update({ state: 'preparing', commit, stage: null })

    // 1. The computer builds the seed and image for this commit; Main follows its stages.
    let state = await this.device(deviceId, { operation: 'prepare', repository, commit,
      review: { reviewedByPrincipalId: principal.id, decisionDigest: profile.approvalConfig.review!.decisionDigest },
      keepImages: [profile.spec.policy.imageDigest] })
    const deadline = Date.now() + PREPARE_LIMIT_MS
    while (state.state === 'preparing') {
      if (Date.now() > deadline) throw new DomainError('CI_RUNTIME_TIMEOUT', 'The computer did not finish preparing its CI runtime in time.', 504)
      update({ stage: state.stage })
      await this.timing.wait(this.timing.pollMs)
      state = await this.device(deviceId, { operation: 'status' })
    }
    if (state.state !== 'prepared' || state.commit !== commit || !state.prepared) {
      throw new DomainError('CI_RUNTIME_PREPARE_FAILED', state.message ?? 'The computer could not prepare its CI runtime.', 502)
    }
    const prepared = state.prepared

    // 2. The computer's root and every verification profile on it move to the commit and the new image.
    update({ state: 'binding', stage: null })
    const pin = { approvedSourceId: approved.manifest.approvedSourceId, snapshotId: approved.manifest.snapshotId,
      manifestDigest: approved.manifest.manifestDigest }
    const rootId = profile.root.binding.rootId
    const current = (await this.sources.rootList(principal, 'mcp', { workspaceId: input.workspaceId, limit: 100 }))
      .items.find(root => root.binding.rootId === rootId)
    if (!current) throw new DomainError('SOURCE_ROOT_NOT_FOUND', 'The build computer\'s root is no longer bound.', 404)
    const root = canonical(current.source) === canonical(pin) ? current : (await this.sources.bindRoot(principal, source, {
      workspaceId: input.workspaceId, source: pin, selection: current.selection, accessMode: current.binding.accessMode,
      expectedBindingRevision: current.binding.bindingRevision, commandId: `${input.commandId}:root` })).value
    // The computer's one protected runtime serves the profiles that share its resources and policy; this one first.
    const runtime = (value: JobVerificationProfile) => canonical({ resources: value.spec.resources, network: value.spec.policy.network,
      toolchain: value.spec.policy.toolchainDigest, approval: value.spec.approvalConfig })
    const group = (await this.profiles.list(principal, input.workspaceId)).profiles.map(value => value.profile)
      .filter((value): value is JobVerificationProfile => value.schemaVersion === 2 && value.root.binding.rootId === rootId
        && runtime(value) === runtime(profile))
      .sort((left, right) => Number(right.id === profile.id) - Number(left.id === profile.id))
    const saved: JobVerificationProfile[] = []
    for (const value of group) {
      saved.push(await this.profiles.save(principal, source, input.workspaceId, { commandId: `${input.commandId}:profile:${value.id}`,
        id: value.id, expectedRevision: value.revision, name: value.name,
        spec: { ...value.spec, rootId, bindingRevision: root.binding.bindingRevision,
          policy: { ...value.spec.policy, imageDigest: prepared.imageId } } }) as JobVerificationProfile)
    }
    update({ profiles: saved.map(value => ({ profileId: value.id, revision: value.revision, status: value.status })) })

    // 3. The computer refreshes its protected runtime and restarts its Worker.
    update({ state: 'refreshing', stage: 'restart' })
    await this.device(deviceId, { operation: 'refresh', commit, root, manifest: approved.manifest, resources: profile.spec.resources })
    const restartDeadline = Date.now() + RESTART_LIMIT_MS
    for (;;) {
      if (Date.now() > restartDeadline) throw new DomainError('CI_RUNTIME_TIMEOUT', 'The computer did not come back after its runtime refresh.', 504)
      await this.timing.wait(this.timing.pollMs)
      const after = await this.device(deviceId, { operation: 'status' }).catch(() => undefined)
      if (!after || after.state === 'refreshing') continue
      if (after.state === 'failed') throw new DomainError('CI_RUNTIME_REFRESH_FAILED', after.message ?? 'The runtime refresh failed.', 502)
      break
    }

    // 4. Every profile on the computer is requalified at the commit.
    update({ state: 'qualifying', stage: null })
    for (const value of saved) {
      update({ stage: value.name })
      const approval = await this.retry(() => this.profiles.requestQualification(principal, source, input.workspaceId,
        { commandId: `${input.commandId}:capture:${value.id}`, profileId: value.id, expectedRevision: value.revision }))
      const qualified = await this.profiles.qualify(principal, source, input.workspaceId,
        `${input.commandId}:qualify:${value.id}`, approval.id)
      update({ profiles: this.runs.get(key)!.profiles.map(entry => entry.profileId === value.id
        ? { ...entry, revision: qualified.revision, status: qualified.status } : entry) })
      if (qualified.status !== 'qualified') {
        throw new DomainError('CI_RUNTIME_QUALIFICATION_FAILED', `${value.name} did not qualify at ${commit.slice(0, 12)}.`, 502)
      }
    }
    update({ state: 'qualified', stage: null })
  }

  /** The Worker's channel comes back a moment after it reconnects; capture retries briefly. */
  private async retry<T>(action: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try { return await action() } catch (error) {
        if (attempt >= 8 || !(error instanceof DomainError) || error.status < 409) throw error
        await this.timing.wait(this.timing.pollMs)
      }
    }
  }

  private async target(principal: ManagementPrincipal, workspaceId: string, profileId: string) {
    const profile = (await this.profiles.list(principal, workspaceId)).profiles.find(value => value.profile.id === profileId)?.profile
    if (!profile) throw new DomainError('JOB_RUNTIME_PROFILE_NOT_FOUND', 'The verification profile was not found.', 404)
    const hostRef = profile.root.selection.hostRef
    if (profile.schemaVersion !== 2 || hostRef.kind !== 'device' || !profile.approvalConfig.review) {
      throw new DomainError('BUILD_COMPUTER_PREPARE_UNSUPPORTED', 'Only reviewed verification profiles on paired computers are prepared automatically.', 409)
    }
    return { profile, deviceId: hostRef.deviceId }
  }

  private async repository(workspaceId: string) {
    const row = (await this.pool.query<{ record: unknown }>('select record from workspaces where id=$1', [workspaceId])).rows[0]
    const repository = row && WorkspaceSchema.parse(row.record).repository
    if (!repository) throw new DomainError('SOURCE_REPOSITORY_REQUIRED', 'Set the workspace GitHub repository so build computers can fetch the commit.', 409)
    return `${repository.owner}/${repository.name}`
  }

  private async device(deviceId: string, request: CiRuntimeRequest): Promise<CiRuntimeWorkerState> {
    const endpoint = this.endpoint()
    if (!endpoint?.capabilities(deviceId).some(value => value.namespace === CI_RUNTIME_NAMESPACE && value.mainCanRequest)) {
      throw new DomainError('COMPUTER_OFFLINE', 'This build computer is offline or its app is too old to prepare its CI runtime.', 409)
    }
    return CiRuntimeWorkerStateSchema.parse((await endpoint.request(deviceId, CI_RUNTIME_NAMESPACE, request,
      { signal: AbortSignal.timeout(120_000) })).payload)
  }

  private set(key: string, value: Status) {
    const status = BuildComputerPrepareStatusSchema.parse({ ...value, updatedAt: this.timing.now().toISOString() })
    this.runs.set(key, status)
    return status
  }
}
