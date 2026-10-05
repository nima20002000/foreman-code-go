import { isDeepStrictEqual } from 'node:util'
import { withAdvancedDefaults, type HarnessConfiguration } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import type { NativeHarnessFactories, NativeHarnessAllocation, HarnessRuntimeRole } from './runtimeFactory.js'
import type { ProductionHarnessRegistry } from './productionRegistry.js'
import type { NativeProcessRecovery } from './recovery/processRegistry.js'
import type { AcceptedHarnessProfileAdmission, AcceptedProfileSelector } from './instanceSettings/acceptedProfile.js'
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
  files?: Extract<NativeHarnessAllocation, { harness: 'codex' }>['chatFiles']
  openCodeFiles?: Extract<NativeHarnessAllocation, { harness: 'opencode' }>['chatFiles']
}) {
  input = { ...input, configuration: structuredClone(input.configuration), selector: structuredClone(input.selector) }
  return input.factories.allocateAdmitted(input.configuration.harness, async (signal, admission) => {
    let binding = input.binding
    if (admission.purpose === 'observation' && binding.kind === 'operator') {
      if (admission.start.kind !== 'operator') throw new DomainError('HARNESS_PROFILE_OWNER_CONFLICT',
        'Operator observation requires its saved Operator session.', 409)
      binding = { kind: 'operator-observation', conversationId: binding.conversationId,
        start: structuredClone(admission.start), session: structuredClone(admission.session) }
    }
    const owner = { ...binding, admissionSignal: signal }
    const observation = owner.kind === 'operator-observation'
    const accepted = observation ? await input.profiles.admitObservation(owner, input.selector)
      : await input.profiles.admit(owner, input.selector)
    signal.throwIfAborted()
    if (!isDeepStrictEqual(withAdvancedDefaults(accepted.override.configuration), withAdvancedDefaults(input.configuration))) throw new DomainError('HARNESS_CONFIGURATION_MISMATCH',
      'The accepted configured profile differs from this immutable native configuration.', 409)
    if (accepted.override.target.hostRef.kind !== 'main') throw new DomainError('HARNESS_HOST_MISMATCH',
      'A selected registered-device profile must execute through its authenticated host.', 409)
    const selection = input.registry.pinOverride(accepted.override)
    const common = { selection, configured: selection.instance, role: input.role, workingDirectory: input.workingDirectory,
      ownerAgentId: input.ownerAgentId, processRecovery: input.recovery, appMcpAccess: input.appMcpAccess,
      ...(input.credentialEnvironmentVariable ? { credentialEnvironmentVariable: input.credentialEnvironmentVariable } : {}),
      revalidateSelection: (effectSignal?: AbortSignal) => {
        const currentOwner = { ...owner, admissionSignal: effectSignal ?? signal }
        return observation ? input.profiles.revalidateObservation(currentOwner, accepted)
          : input.profiles.revalidate(currentOwner, accepted)
      } }
    return input.configuration.harness === 'codex' ? { ...common, harness: 'codex', ...(input.files ? { chatFiles: input.files } : {}) }
      : { ...common, harness: 'opencode', ...(input.configuration.advanced ? { advancedConfiguration: input.configuration.advanced } : {}),
        ...(input.openCodeFiles ? { chatFiles: input.openCodeFiles } : {}) }
  })
}
