import { createHash } from 'node:crypto'
import { HostHarnessProfileCheckRequestSchema, HostHarnessInstanceCheckInputSchema, HostHarnessProfileEvidenceSchema, type HostHarnessInstanceCheckInput, type HostHarnessOverride, type HostHarnessProfileEvidence } from '@foreman-code/contracts/harness-registry'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { requireAuthorization } from '../../access/policy.js'
import type { PostgresCommandCoordinator } from '../../commands/postgres.js'
import { DomainError } from '../../errors.js'
import { assertClaudeFullAccess } from '../nativeWorkflowConfiguration.js'
import type { HostHarnessOverrideAuthority } from './service.js'
import { harnessHostKey, type HarnessInstanceSettingsRepository } from './repository.js'
import type { NativeQualificationRetention } from '../installedNativeQualificationRetention.js'
import type { HostHarnessProfileEvidenceRepository } from './profileRepository.js'

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
    const selected = async (client: import('pg').PoolClient, lockRevision = false) => {
      await authorize(client)
      if (lockRevision) await this.settings.lockRevision(client, input.instanceId)
      const value = await this.settings.latest(client, input.instanceId)
      if (!value || value.revision !== input.expectedRevision || !sameTarget(value.target, input.target)) throw new DomainError('REVISION_CONFLICT', 'The exact host instance changed before qualification.', 409)
      if (!value.enabled) throw new DomainError('HARNESS_INSTANCE_DISABLED', 'Disabled host instances cannot be qualified.', 409)
      assertClaudeFullAccess(value.configuration)
      return value
    }
    const checkId = nativeProfileCheckId(input.target.hostRef.mainId, principal.id, input.commandId)
    const matches = (proof: HostHarnessProfileEvidence, value: HostHarnessOverride) => sameTarget(proof.target, value.target)
      && proof.instanceRevision === value.instanceRevision && proof.configurationFingerprint === value.configurationFingerprint && proof.driverId === value.driverId
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(new DomainError('HARNESS_PROFILE_CHECK_TIMEOUT', 'Exact-host profile qualification exceeded its deadline.', 504)), 240_000)
    timer.unref()
    const signal = AbortSignal.any([this.stopping.signal, deadline.signal])
    try { return await this.commands.execute({ principal, source, operation: 'harness.instance.check', commandId: input.commandId,
      targetKey: `harness-instance:${input.instanceId}`, payload: input, dedicatedConnection: true, authorize,
      perform: async client => {
        // Force checks for the same instance run in order; a late older check cannot supersede a newer result.
        const profileLock = `harness-instance-profile:${input.instanceId}`
        await client.query('select pg_advisory_lock(hashtext($1))', [profileLock])
        try {
          signal.throwIfAborted()
          const value = await this.settings.readAuthorized(selected)
          HostHarnessProfileCheckRequestSchema.parse({ checkId, override: value })
          // Recover the same completed check after proof commit but before receipt commit; never repeat native effects.
          const previous = await this.proofs.findCheck(checkId, value.instanceId, value.revision)
          if (previous) {
            if (!matches(previous, value)) throw new DomainError('COMMAND_ID_CONFLICT', 'The completed check belongs to different profile input.', 409)
            return { override: value, proof: previous }
          }
          signal.throwIfAborted()
          const proof = HostHarnessProfileEvidenceSchema.parse(await this.qualifier.qualify(value, { checkId, signal }))
          signal.throwIfAborted()
          if (!matches(proof, value)) {
            throw new DomainError('HARNESS_PROFILE_EVIDENCE_MISMATCH', 'Native qualification did not match the exact selected host profile.', 409)
          }
          await this.settings.readAuthorized(async client => {
            await selected(client, true)
            signal.throwIfAborted()
            if (proof.completedNativeQualification && !this.nativeRetention) throw new DomainError(
              'HARNESS_NATIVE_RETENTION_UNAVAILABLE', 'Completed native qualification requires the Main transaction retention service.', 503)
            const finalFence = proof.completedNativeQualification ? await this.nativeRetention!.retain(client, value, proof, checkId, signal) : undefined
            await this.proofs.append(client, checkId, value, proof)
            await finalFence?.()
          })
          return { override: value, proof }
        } finally { await client.query('select pg_advisory_unlock(hashtext($1))', [profileLock]).catch(() => undefined) }
      },
    }) } finally { clearTimeout(timer) }
  }
}
