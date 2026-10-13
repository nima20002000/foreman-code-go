import { createHash, randomUUID } from 'node:crypto'
import { RETIRED_OPENCODE_MESSAGE } from '@foreman-code/contracts'
import type pg from 'pg'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { CanonicalMachineReference } from '@foreman-code/contracts/device-identity'
import { assertDeviceHostInstallation } from '../../devices/hostAuthorization.js'
import { harnessConnectionGeneration } from '../hostConnectionGeneration.js'
import { HostHarnessProfileCheckRequestSchema, HostHarnessInstanceCheckInputSchema, HostHarnessProfileEvidenceSchema, type HostHarnessInstanceCheckInput, type HostHarnessOverride, type HostHarnessProfileEvidence } from '@foreman-code/contracts/harness-registry'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { requireAuthorization } from '../../access/policy.js'
import type { PostgresCommandCoordinator } from '../../commands/postgres.js'
import { DomainError } from '../../errors.js'
import { assertClaudeFullAccess } from '../nativeWorkflowConfiguration.js'
import type { HostHarnessOverrideAuthority } from './authority.js'
import { harnessHostKey, type HarnessInstanceSettingsRepository } from './repository.js'
import type { NativeQualificationRetention } from '../installedNativeQualificationRetention.js'
import type { HostHarnessProfileEvidenceRepository } from './profileRepository.js'
import type { HarnessInstallationRecord } from '../installationRegistry.js'
import { qualificationError } from '../qualificationErrors.js'
import { CLAUDE_PROFILE_CHECK_REVISION } from '../claudeSdk/profileRevision.js'

export interface AutomaticHostProfileCheck {
  host: CanonicalMachineReference
  driverId: string
  applicationInstallationId: string
  generation: string
  signal: AbortSignal
  authorize(client: pg.PoolClient): Promise<void>
  installation(value: HostHarnessOverride): HarnessInstallationRecord | undefined
  beforeChecks?: () => Promise<void>
}

export interface HostHarnessProfileQualifier {
  /** Actual admitted factory/worker implementation; includes current driver suite and model/profile qualification. */
  qualify(value: HostHarnessOverride, input: { checkId: string; signal: AbortSignal }): Promise<HostHarnessProfileEvidence>
}
const sameTarget = (a: HostHarnessOverride['target'], b: HostHarnessOverride['target']) => harnessHostKey(a.hostRef) === harnessHostKey(b.hostRef)
  && a.applicationInstallationId === b.applicationInstallationId && a.harnessInstallationId === b.harnessInstallationId && a.installationFingerprint === b.installationFingerprint

export function nativeProfileCheckId(mainId: string, principalId: string, commandId: string): string {
  const hex = createHash('sha256').update(JSON.stringify(['harness.instance.check', mainId, principalId, commandId])).digest('hex').slice(0, 32)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`
}

/** Reuses command receipts; native IO runs outside authority row locks and proof commit reauthorizes. */
export class HostHarnessInstanceProfileChecks {
  private readonly stopping = new AbortController()
  private readonly flights = new Set<Promise<unknown>>()
  private readonly reconnects = new Map<string, { generation: string; task: Promise<void> }>()
  private readonly updates = new Map<string, {
    hostKey: string; generation: string; abort: AbortController; task: Promise<void>
  }>()
  constructor(private readonly settings: HarnessInstanceSettingsRepository, private readonly proofs: HostHarnessProfileEvidenceRepository,
    private readonly commands: PostgresCommandCoordinator, private readonly authority: HostHarnessOverrideAuthority,
    private readonly qualifier: HostHarnessProfileQualifier, private readonly nativeRetention?: NativeQualificationRetention) {}
  check(principal: ManagementPrincipal, source: 'http' | 'mcp', input: HostHarnessInstanceCheckInput) {
    if (this.stopping.signal.aborted) return Promise.reject(new DomainError('HARNESS_CHECK_SHUTTING_DOWN', 'Host profile checks are stopping.', 503))
    if (this.flights.size >= 16) return Promise.reject(new DomainError('HARNESS_PROFILE_CHECK_BUSY', 'Host profile checks are busy; retry the same command.', 429))
    const flight = this.perform(principal, source, input).then(async result => {
      if (result.value.proof.completedNativeQualification) {
        if (!this.nativeRetention) throw new DomainError('HARNESS_NATIVE_RETENTION_UNAVAILABLE',
          'Completed native qualification requires the Main transaction retention service.', 503)
        await this.nativeRetention.refresh(result.value.override, this.stopping.signal)
      }
      return result
    })
    this.flights.add(flight)
    void flight.finally(() => this.flights.delete(flight)).catch(() => undefined)
    return flight
  }
  recheckWorker(binding: Readonly<DeviceSessionBinding>, connectionSignal: AbortSignal,
    currentBinding: () => Readonly<DeviceSessionBinding> | null): Promise<void> {
    const host = { kind: 'device' as const, mainId: binding.mainId, deviceId: binding.deviceId }
    const key = harnessHostKey(host)
    const generation = harnessConnectionGeneration(binding)
    const previous = this.reconnects.get(key)
    if (previous?.generation === generation) return previous.task
    const signal = AbortSignal.any([this.stopping.signal, connectionSignal])
    const task = this.recheckProfiles(host, binding, signal, currentBinding)
    const entry = { generation, task }
    this.reconnects.set(key, entry)
    this.flights.add(task)
    const cleanup = () => {
      this.flights.delete(task)
      if (this.reconnects.get(key) === entry) this.reconnects.delete(key)
    }
    void task.then(cleanup, cleanup)
    return task
  }
  assertReady(host: CanonicalMachineReference): void {
    if (this.pending(host)) {
      throw new DomainError('HARNESS_PROFILE_CHECK_PENDING',
        'This computer is checking its harness profiles after an installation or connection change. Retry Run start shortly.',
        503, { reason: 'automatic_profile_check_pending', retryable: true })
    }
  }
  pending(host: CanonicalMachineReference): boolean {
    const key = harnessHostKey(host)
    return this.reconnects.has(key) || [...this.updates.values()].some(update => update.hostKey === key)
  }
  async failure(value: HostHarnessOverride, client?: pg.PoolClient) {
    return (await this.proofs.latest(value.instanceId, value.revision, client))?.failure
  }
  recheckInstallation(input: AutomaticHostProfileCheck): Promise<void> {
    const hostKey = harnessHostKey(input.host)
    const key = `${hostKey}:${input.driverId}`
    const previous = this.updates.get(key)
    if (previous?.generation === input.generation) return previous.task
    const abort = new AbortController()
    previous?.abort.abort(new DomainError('HARNESS_INVENTORY_STALE', 'The harness installation changed again.', 409))
    const signal = AbortSignal.any([input.signal, abort.signal, this.stopping.signal])
    const task = Promise.resolve().then(async () => {
      if (previous) await Promise.allSettled([previous.task])
      signal.throwIfAborted()
      await this.recheckInstalledProfiles({ ...input, signal })
    })
    const entry = { hostKey, generation: input.generation, abort, task }
    this.updates.set(key, entry)
    this.flights.add(task)
    const cleanup = () => {
      this.flights.delete(task)
      if (this.updates.get(key) === entry) this.updates.delete(key)
    }
    void task.then(cleanup, cleanup)
    return task
  }
  private async recheckInstalledProfiles(input: AutomaticHostProfileCheck): Promise<void> {
    const profiles = await this.settings.list(input.host, input.applicationInstallationId)
    const qualified: HostHarnessOverride[] = []
    for (const value of profiles) {
      input.signal.throwIfAborted()
      if (!value.enabled || value.driverId !== input.driverId
        || value.driverId === 'opencode' || value.configuration.harness === 'opencode') continue
      if (await this.proofs.previouslyQualified(value)) qualified.push(value)
    }
    if (!qualified.length) return
    let preparationFailure: unknown
    try {
      if (qualified.some(value => value.driverId === 'codex')) await input.beforeChecks?.()
    } catch (error) { preparationFailure = error }
    const failures: unknown[] = []
    for (const saved of qualified) {
      input.signal.throwIfAborted()
      const installation = input.installation(saved)
      const checkId = randomUUID()
      let value = saved
      try {
        if (!installation?.installed || !installation.installationFingerprint) throw new DomainError(
          'HARNESS_INSTALLATION_UNAVAILABLE', 'The updated harness installation is unavailable.', 409)
        const target = { ...saved.target, harnessInstallationId: installation.harnessInstallationId,
          installationFingerprint: installation.installationFingerprint }
        if (!sameTarget(target, saved.target)) {
          value = await this.settings.readAuthorized(async client => {
            await input.authorize(client)
            input.signal.throwIfAborted()
            return this.settings.replaceInstallation(client, saved, target)
          })
        }
        if (preparationFailure && value.driverId === 'codex') throw preparationFailure
        const bounded = AbortSignal.any([input.signal, AbortSignal.timeout(240_000)])
        const request = { commandId: checkId, instanceId: value.instanceId,
          expectedRevision: value.revision, target: value.target }
        const result = await this.settings.withProfileConnection(client =>
          this.qualifyProfile(client, request, checkId, input.authorize, bounded, 'system'))
        if (result.proof.completedNativeQualification) await this.nativeRetention!.refresh(result.override, bounded)
      } catch (error) {
        input.signal.throwIfAborted()
        const failure = qualificationError(error)
        await this.settings.readAuthorized(async client => {
          await input.authorize(client)
          await this.settings.lockRevision(client, value.instanceId)
          const current = await this.settings.latest(client, value.instanceId)
          if (current?.revision !== value.revision) return
          if (installation && sameTarget(value.target, { ...value.target,
            harnessInstallationId: installation.harnessInstallationId,
            installationFingerprint: installation.installationFingerprint ?? value.target.installationFingerprint })) {
            const proof = HostHarnessProfileEvidenceSchema.parse({ target: value.target,
              instanceRevision: value.instanceRevision, configurationFingerprint: value.configurationFingerprint,
              driverId: value.driverId, driverRevision: installation.driverRevision,
              protocolRevision: installation.protocolRevision,
              suiteRevision: value.driverId === 'claude' ? CLAUDE_PROFILE_CHECK_REVISION : `${value.driverId}-profile-check-v1`,
              environmentGeneration: installation.environmentGeneration, connectionGeneration: installation.connectionGeneration,
              authenticated: null, compatible: null, qualified: false,
              failure: { code: failure.code, message: failure.message.slice(0, 500) }, checkedAt: new Date().toISOString() })
            const completed = await this.proofs.findCheck(checkId, value.instanceId, value.revision, client)
            await this.proofs.append(client, completed ? randomUUID() : checkId, value, proof)
          } else {
            const previous = await this.proofs.latest(value.instanceId, value.revision, client)
            if (previous) await this.proofs.append(client, checkId, value, { ...previous,
              qualified: false, authenticated: null, compatible: null,
              failure: { code: failure.code, message: failure.message.slice(0, 500) }, checkedAt: new Date().toISOString() })
          }
          await client.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details)
            values(null,'system','harness.instance.check',$1,'failed',$2::jsonb)`,
          [`harness-instance:${value.instanceId}`, JSON.stringify({ checkId, code: failure.code })])
        })
        failures.push(error)
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Automatic harness profile checks failed.')
  }
  private async recheckProfiles(host: CanonicalMachineReference, binding: Readonly<DeviceSessionBinding>,
    signal: AbortSignal, currentBinding: () => Readonly<DeviceSessionBinding> | null): Promise<void> {
    const profiles = await this.settings.list(host, binding.workerInstallationId)
    const failures: unknown[] = []
    for (const value of profiles) {
      signal.throwIfAborted()
      if (!value.enabled || value.driverId === 'opencode' || value.configuration.harness === 'opencode') continue
      const previous = await this.proofs.latest(value.instanceId, value.revision)
      if (!previous?.qualified || previous.authenticated !== true || previous.compatible !== true) continue
      const generation = harnessConnectionGeneration(binding)
      if (previous.connectionGeneration === generation) continue
      const checkId = nativeProfileCheckId(binding.mainId, 'system',
        `${generation}:${value.instanceId}:${value.revision}`)
      const input = { commandId: checkId, instanceId: value.instanceId,
        expectedRevision: value.revision, target: value.target }
      const authorize = async (client: pg.PoolClient) => {
        signal.throwIfAborted()
        const registration = await assertDeviceHostInstallation(client, host, binding.workerInstallationId)
        const current = currentBinding()
        if (!registration || registration.keyRevision !== binding.keyRevision
          || registration.authorizationRevision !== binding.authorizationRevision
          || !current || harnessConnectionGeneration(current) !== generation) {
          throw new DomainError('HARNESS_INVENTORY_STALE', 'The Worker connection changed during its profile check.', 409)
        }
      }
      try {
        const bounded = AbortSignal.any([signal, AbortSignal.timeout(240_000)])
        const result = await this.settings.withProfileConnection(client =>
          this.qualifyProfile(client, input, checkId, authorize, bounded, 'system'))
        if (result.proof.completedNativeQualification) await this.nativeRetention!.refresh(result.override, bounded)
      } catch (error) {
        await this.settings.readAuthorized(client => client.query(`insert into management_audit
          (principal_id,source,action,target_key,outcome,details)
          values(null,'system','harness.instance.check',$1,'failed',$2::jsonb)`,
        [`harness-instance:${value.instanceId}`, JSON.stringify({ checkId,
          code: error instanceof DomainError ? error.code : 'HARNESS_PROFILE_CHECK_FAILED' })]))
        failures.push(error)
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Automatic Worker profile checks failed.')
  }
  async close(): Promise<void> {
    this.stopping.abort(new Error('Host profile checks are stopping.'))
    await Promise.allSettled([...this.flights])
  }
  private async perform(principal: ManagementPrincipal, source: 'http' | 'mcp', raw: HostHarnessInstanceCheckInput) {
    requireAuthorization(principal, 'harnesses:read'); requireAuthorization(principal, 'harnesses:update')
    const input = HostHarnessInstanceCheckInputSchema.parse(raw)
    const authorize = async (client: import('pg').PoolClient) => {
      await this.authority.authorize(principal, 'harnesses:read', input.target.hostRef, input.target.applicationInstallationId, client)
      await this.authority.authorize(principal, 'harnesses:update', input.target.hostRef, input.target.applicationInstallationId, client)
    }
    await this.settings.readAuthorized(async client => {
      await authorize(client)
      const saved = await this.settings.latest(client, input.instanceId)
      if (saved && sameTarget(saved.target, input.target)
        && (saved.driverId === 'opencode' || saved.configuration.harness === 'opencode')) {
        throw new DomainError('HARNESS_RETIRED', RETIRED_OPENCODE_MESSAGE, 409)
      }
    })
    const checkId = nativeProfileCheckId(input.target.hostRef.mainId, principal.id, input.commandId)
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(new DomainError('HARNESS_PROFILE_CHECK_TIMEOUT', 'Exact-host profile qualification exceeded its deadline.', 504)), 240_000)
    timer.unref()
    const signal = AbortSignal.any([this.stopping.signal, deadline.signal])
    try { return await this.commands.execute({ principal, source, operation: 'harness.instance.check', commandId: input.commandId,
      targetKey: `harness-instance:${input.instanceId}`, payload: input, dedicatedConnection: true, authorize,
      perform: client => this.qualifyProfile(client, input, checkId, authorize, signal),
    }) } finally { clearTimeout(timer) }
  }
  private async selectProfile(input: HostHarnessInstanceCheckInput,
    authorize: (client: pg.PoolClient) => Promise<void>, client: pg.PoolClient,
    options?: { lockRevision: true }) {
    await authorize(client)
    if (options?.lockRevision) await this.settings.lockRevision(client, input.instanceId)
    const value = await this.settings.latest(client, input.instanceId)
    if (!value || value.revision !== input.expectedRevision || !sameTarget(value.target, input.target)) {
      throw new DomainError('REVISION_CONFLICT', 'The exact host instance changed before qualification.', 409)
    }
    if (value.driverId === 'opencode' || value.configuration.harness === 'opencode') throw new DomainError(
      'HARNESS_RETIRED', RETIRED_OPENCODE_MESSAGE, 409)
    if (!value.enabled) throw new DomainError('HARNESS_INSTANCE_DISABLED', 'Disabled host instances cannot be qualified.', 409)
    assertClaudeFullAccess(value.configuration)
    return value
  }
  private async qualifyProfile(client: pg.PoolClient, input: HostHarnessInstanceCheckInput, checkId: string,
    authorize: (client: pg.PoolClient) => Promise<void>, signal: AbortSignal, source?: 'system') {
    const profileLock = `harness-instance-profile:${input.instanceId}`
    await client.query('select pg_advisory_lock(hashtext($1))', [profileLock])
    try {
      signal.throwIfAborted()
      const value = await this.settings.readAuthorized(client => this.selectProfile(input, authorize, client))
      HostHarnessProfileCheckRequestSchema.parse({ checkId, override: value })
      const matches = (proof: HostHarnessProfileEvidence) => sameTarget(proof.target, value.target)
        && proof.instanceRevision === value.instanceRevision
        && proof.configurationFingerprint === value.configurationFingerprint && proof.driverId === value.driverId
      const previous = await this.proofs.findCheck(checkId, value.instanceId, value.revision)
      if (previous) {
        if (!matches(previous)) throw new DomainError('COMMAND_ID_CONFLICT',
          'The completed check belongs to different profile input.', 409)
        return { override: value, proof: previous }
      }
      signal.throwIfAborted()
      const proof = HostHarnessProfileEvidenceSchema.parse(await this.qualifier.qualify(value, { checkId, signal }))
      signal.throwIfAborted()
      if (!matches(proof)) throw new DomainError('HARNESS_PROFILE_EVIDENCE_MISMATCH',
        'Native qualification did not match the exact selected host profile.', 409)
      await this.settings.readAuthorized(async client => {
        await this.selectProfile(input, authorize, client, { lockRevision: true })
        signal.throwIfAborted()
        if (proof.completedNativeQualification && !this.nativeRetention) throw new DomainError(
          'HARNESS_NATIVE_RETENTION_UNAVAILABLE', 'Completed native qualification requires the Main transaction retention service.', 503)
        const finalFence = proof.completedNativeQualification
          ? await this.nativeRetention!.retain(client, value, proof, checkId, signal) : undefined
        await this.proofs.append(client, checkId, value, proof)
        if (source === 'system') {
          await client.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details)
            values(null,'system','harness.instance.check',$1,'succeeded',$2::jsonb)`,
          [`harness-instance:${value.instanceId}`, JSON.stringify({ checkId, qualified: proof.qualified })])
        }
        await finalFence?.()
      })
      return { override: value, proof }
    } finally {
      await client.query('select pg_advisory_unlock(hashtext($1))', [profileLock])
    }
  }

}
