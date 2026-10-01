import type { ClaudeHarnessConfiguration } from '@graphql/contracts/claude'
import type { HarnessOptions } from '@graphql/contracts/management'
import type { HarnessQualification } from '@graphql/contracts'

/** Injected pinned-release discovery; it creates no conversation or model turn. */
export interface ClaudeNativeConfigurationPort {
  qualify(configuration: ClaudeHarnessConfiguration, workingDirectory: string, signal: AbortSignal): Promise<HarnessQualification>
  discover(workingDirectory: string, signal: AbortSignal): Promise<Omit<HarnessOptions, 'harness' | 'settings' | 'restrictions' | 'checkedAt'>>
}
export function claudeSettingSupport(): HarnessOptions['settings'] {
  return [
    { field: 'model', support: 'conditional', detail: 'Only models observed from the selected local installation are selectable.' },
    { field: 'permissions', support: 'conditional', detail: 'Default permission mode and routed approvals require qualified always-applied policy checks.' },
    { field: 'sandbox', support: 'conditional', detail: 'Read-only and workspace-write require native OS enforcement proof; plan mode is not read-only.' },
    { field: 'instructions', support: 'conditional', detail: 'Only accepted pinned instructions are delivered; ambient settings and plugins are excluded.' },
    { field: 'mcp', support: 'conditional', detail: 'Only explicitly approved endpoints; app and file authorization remain server-side.' },
  ]
}
