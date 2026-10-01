import type { CompatibilityOptions } from './compatibility/service.js'
import type { CodexPluginAdapter } from './codexPlugins.js'
import type { NativeMcpAdapter } from './nativeMcpCommon.js'
import type { runCommand } from './process.js'
import type { NativeFactoryInfrastructure } from './runtimeFactory.js'
import type { HarnessInstallationRegistry, RegistryHarnessSelection } from './installationRegistry.js'
import type { QualificationSuiteInput } from './qualification/types.js'
import type { NativeProcessRegistry } from './recovery/processRegistry.js'

/** Settings/probes are separate privileges from native turn execution. A replay
 * must supply these ports even when its scenario does not exercise them. */
export interface AuxiliaryHarnessInfrastructure {
  recovery: Pick<NativeProcessRegistry, 'scope' | 'reserveLaunch' | 'abandonReservedLaunch' | 'closeOwner'>
  compatibility: CompatibilityOptions
  plugins: CodexPluginAdapter
  mcp: { codex: NativeMcpAdapter; opencode: NativeMcpAdapter }
  command: typeof runCommand
}
export type ProductionHarnessInfrastructure = NativeFactoryInfrastructure & {
  qualificationIdentity?: {
    registry: HarnessInstallationRegistry
    pin: (harness: 'codex' | 'opencode', input: QualificationSuiteInput) => RegistryHarnessSelection
  }
} & (
  | { mode: 'native'; auxiliary?: AuxiliaryHarnessInfrastructure }
  | { mode: 'replay'; auxiliary: AuxiliaryHarnessInfrastructure }
)
