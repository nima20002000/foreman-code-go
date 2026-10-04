import { HostHarnessProfileEvidenceSchema, type HostHarnessOverride, type HostHarnessProfileEvidence } from '@graphql/contracts/harness-registry'
import { withAdvancedDefaults } from '@graphql/contracts'
import { commandInputHash } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { WorkerExecutionPolicy } from '../settings/workerExecution.js'
import type { DeviceEndpoint } from '../devices/deviceEndpoint.js'
import type { HostHarnessProfileQualifier } from './instanceSettings/profileChecks.js'
import { harnessHostKey } from './instanceSettings/repository.js'
import type { ProductionHarnessRegistry } from './productionRegistry.js'
import type { NativeHarnessFactories } from './runtimeFactory.js'
import { harnessProfile } from './qualification/profiles.js'
import { qualificationError } from './qualificationErrors.js'
import { requireClaudeProductionCredentialDelivery } from './claudeSdk/productionCredentials.js'

/** Explicit profile checks enter through real role-isolated adapters. A saved
 * config, filesystem inventory, worker heartbeat or fixture never grants trust. */
export class ProductionHostHarnessProfileQualifier implements HostHarnessProfileQualifier {
  constructor(private readonly registry: ProductionHarnessRegistry, private readonly factories: NativeHarnessFactories,
    private readonly endpoint: () => DeviceEndpoint, private readonly workingDirectory: string,
    private readonly claude?: HostHarnessProfileQualifier,
    private readonly workerExecution = new WorkerExecutionPolicy()) {}
  async qualify(value: HostHarnessOverride, input: { checkId: string; signal: AbortSignal }): Promise<HostHarnessProfileEvidence> {
    this.workerExecution.requireEnabled(value.target.hostRef)
    input.signal.throwIfAborted()
    if (commandInputHash(withAdvancedDefaults(value.configuration)) !== value.configurationFingerprint) {
      throw new DomainError('HARNESS_CONFIGURATION_MISMATCH', 'The saved configuration fingerprint is invalid.', 409)
    }
    requireClaudeProductionCredentialDelivery(value.configuration)
    if (value.target.hostRef.kind === 'device') {
      const endpoint = this.endpoint()
      if (!endpoint.capabilities(value.target.hostRef.deviceId).some((item) => item.namespace === 'host-harness-check-v1' && item.mainCanRequest)) {
        throw new DomainError('HARNESS_REMOTE_CHECK_UNAVAILABLE', 'The authenticated worker has no real host profile check handler.', 409)
      }
      const binding = this.registry.pinOverride(value)
      const result = await endpoint.request(value.target.hostRef.deviceId, 'host-harness-check-v1',
        { checkId: input.checkId, override: value }, { signal: input.signal, timeoutMs: 240_000 })
      input.signal.throwIfAborted()
      this.registry.installations.assertCurrent(binding)
      const proof = HostHarnessProfileEvidenceSchema.parse(result.payload)
      if (commandInputHash(proof.target) !== commandInputHash(value.target) || proof.instanceRevision !== value.instanceRevision
        || proof.configurationFingerprint !== value.configurationFingerprint || proof.driverId !== value.driverId
        || proof.driverRevision !== binding.installation.driverRevision || proof.protocolRevision !== binding.installation.protocolRevision
        || proof.suiteRevision !== `${value.driverId}-profile-check-v1`
        || proof.environmentGeneration !== binding.installation.environmentGeneration
        || proof.connectionGeneration !== binding.installation.connectionGeneration) {
        throw new DomainError('HARNESS_PROFILE_EVIDENCE_MISMATCH', 'Worker qualification did not match the exact authorized installation context.', 409)
      }
      return proof
    }
    await this.registry.refreshMain(input.signal)
    const binding = this.registry.pinOverride(value)
    if (harnessHostKey(binding.selection.hostRef) !== harnessHostKey(value.target.hostRef)) throw new DomainError(
      'HARNESS_PROFILE_EVIDENCE_MISMATCH', 'The native check must run on the exact selected host.', 409)
    const configuration = value.configuration
    if (configuration.harness === 'claude' && this.claude) return this.claude.qualify(value, input)
    if (configuration.harness !== 'codex' && configuration.harness !== 'opencode') throw new DomainError(
      'HARNESS_DRIVER_UNAVAILABLE', 'This host has no qualified implementation for the selected driver.', 409)
    const allocation = this.factories.allocate({ harness: configuration.harness, role: 'qualification', selection: binding,
      configured: binding.instance, workingDirectory: this.workingDirectory,
      ownerAgentId: `profile-check:${input.checkId}`, appMcpAccess: 'none',
      ...(configuration.harness === 'opencode' && configuration.advanced ? { advancedConfiguration: configuration.advanced } : {}),
    })
    let authenticated: boolean | null = null
    let compatible: boolean | null = null
    let qualified = false
    let failure: { code: string; message: string } | undefined
    try {
      this.factories.admitAuxiliary(allocation.manager)
      await this.factories.assertInstallationUnchanged(binding, input.signal)
      if (allocation.harness === 'codex' && configuration.harness === 'codex') {
        const checked = await allocation.manager.qualifyConfiguration(configuration, this.workingDirectory, input.signal)
        authenticated = checked.authenticated; compatible = checked.structuredEvents
        qualified = checked.ready && harnessProfile('codex', checked.version) !== null
      } else if (allocation.harness === 'opencode' && configuration.harness === 'opencode') {
        const checked = await allocation.manager.qualifyConfiguration(configuration, this.workingDirectory, input.signal)
        authenticated = checked.authenticated; compatible = checked.structuredEvents
        qualified = checked.ready && harnessProfile('opencode', checked.version) !== null
      }
      await this.factories.assertInstallationUnchanged(binding, input.signal)
      this.registry.installations.assertCurrent(binding)
    } catch (error) {
      input.signal.throwIfAborted()
      const code = error instanceof DomainError ? error.code
        : typeof error === 'object' && error && 'result' in error ? (error as { result?: { error?: { code?: string } } }).result?.error?.code : undefined
      if (!code || !/^(?:CODEX_(?:SETTING|MODEL|MCP|REQUIRED_MCP|APP_SERVER_AUTH)|OPENCODE_(?:SETTING|MODEL|PROVIDER|AGENT|VARIANT|MCP|SERVER_VERSION))/.test(code)) throw error
      const sanitized = qualificationError(error)
      failure = { code: sanitized.code, message: sanitized.message }
      qualified = false
      // Unknown stages remain unknown; this negative result replaces earlier trust.
    } finally { await this.factories.disposeAuxiliary(allocation.manager) }
    input.signal.throwIfAborted()
    this.registry.installations.assertCurrent(binding)
    return HostHarnessProfileEvidenceSchema.parse({ target: value.target, instanceRevision: value.instanceRevision,
      configurationFingerprint: value.configurationFingerprint, driverId: value.driverId,
      driverRevision: binding.installation.driverRevision, protocolRevision: binding.installation.protocolRevision,
      suiteRevision: `${value.driverId}-profile-check-v1`, environmentGeneration: binding.installation.environmentGeneration,
      connectionGeneration: binding.installation.connectionGeneration, authenticated, compatible, qualified, ...(failure ? { failure } : {}),
      checkedAt: new Date().toISOString() })
  }
}
