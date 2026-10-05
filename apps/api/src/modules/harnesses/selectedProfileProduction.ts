import { isDeepStrictEqual } from 'node:util'
import { withAdvancedDefaults, type HarnessConfiguration } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import type { NativeHarnessFactories, NativeHarnessAllocation, HarnessRuntimeRole } from './runtimeFactory.js'
import type { ProductionHarnessRegistry } from './productionRegistry.js'
import type { NativeProcessRecovery } from './recovery/processRegistry.js'
import type { AcceptedHarnessProfileAdmission, AcceptedProfileSelector } from './instanceSettings/acceptedProfile.js'
import type { WorkflowNativeOutputs } from './workflowNativeOutput.js'
import type { ClaudeProfileOwner } from './claudeSdk/production.js'

/** Exact selected profiles never fall through to unselected local defaults.
 * The existing native adapter still performs its protocol/model/auth checks. */
export function productionSelectedProfileManager(input: {
  factories: NativeHarnessFactories
  registry: ProductionHarnessRegistry
  profiles: AcceptedHarnessProfileAdmission<ClaudeProfileOwner>
  selector: AcceptedProfileSelector
  binding: ClaudeProfileOwner
  configuration: Exclude<HarnessConfiguration, { harness: 'claude' }>
  role: Extract<HarnessRuntimeRole, 'workflow' | 'operator' | 'agent-chat'>
  workingDirectory: string
  ownerAgentId: string
  recovery: NativeProcessRecovery
  appMcpAccess: 'scoped' | 'none'
  credentialEnvironmentVariable?: string
  nativeOutputs?: WorkflowNativeOutputs
  files?: Extract<NativeHarnessAllocation, { harness: 'codex' }>['chatFiles']
  openCodeFiles?: Extract<NativeHarnessAllocation, { harness: 'opencode' }>['chatFiles']
}) {
  input = { ...input, configuration: structuredClone(input.configuration), selector: structuredClone(input.selector) }
  return input.factories.allocateAdmitted(input.configuration.harness, async signal => {
    const owner = { ...input.binding, admissionSignal: signal }
    const accepted = await input.profiles.admit(owner, input.selector)
    signal.throwIfAborted()
    if (!isDeepStrictEqual(withAdvancedDefaults(accepted.override.configuration), withAdvancedDefaults(input.configuration))) throw new DomainError('HARNESS_CONFIGURATION_MISMATCH',
      'The accepted configured profile differs from this immutable native configuration.', 409)
    if (accepted.override.target.hostRef.kind !== 'main') throw new DomainError('HARNESS_HOST_MISMATCH',
      'A selected registered-device profile must execute through its authenticated host.', 409)
    const selection = input.registry.pinOverride(accepted.override)
    const common = { selection, configured: selection.instance, role: input.role, workingDirectory: input.workingDirectory,
      ownerAgentId: input.ownerAgentId, processRecovery: input.recovery, appMcpAccess: input.appMcpAccess,
      ...(input.credentialEnvironmentVariable ? { credentialEnvironmentVariable: input.credentialEnvironmentVariable } : {}),
      revalidateSelection: (effectSignal?: AbortSignal) => input.profiles.revalidate({ ...owner, admissionSignal: effectSignal ?? signal }, accepted) }
    return input.configuration.harness === 'codex' ? { ...common, harness: 'codex', ...(input.nativeOutputs ? { nativeOutputs: input.nativeOutputs.codex } : {}), ...(input.files ? { chatFiles: input.files } : {}) }
      : { ...common, harness: 'opencode', ...(input.nativeOutputs ? { nativeOutputs: input.nativeOutputs.opencode } : {}), ...(input.configuration.advanced ? { advancedConfiguration: input.configuration.advanced } : {}),
        ...(input.openCodeFiles ? { chatFiles: input.openCodeFiles } : {}) }
  })
}
