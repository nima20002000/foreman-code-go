import type { CompatibilityOptions } from './compatibility/service.js'
import type { CodexPluginAdapter } from './codexPlugins.js'
import type { NativeMcpAdapter } from './nativeMcpCommon.js'
import type { runCommand } from './process.js'
import type { NativeFactoryInfrastructure } from './runtimeFactory.js'

/** Settings/probes are separate privileges from native turn execution. A replay
 * must supply these ports even when its scenario does not exercise them. */
export interface AuxiliaryHarnessInfrastructure {
  compatibility: CompatibilityOptions
  plugins: CodexPluginAdapter
  mcp: { codex: NativeMcpAdapter; opencode: NativeMcpAdapter }
  command: typeof runCommand
}
export type ProductionHarnessInfrastructure = NativeFactoryInfrastructure & (
  | { mode: 'native'; auxiliary?: AuxiliaryHarnessInfrastructure }
  | { mode: 'replay'; auxiliary: AuxiliaryHarnessInfrastructure }
)
