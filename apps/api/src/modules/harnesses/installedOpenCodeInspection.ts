import { inspectInstalledHarness } from './installedCodexInspection.js'
import type { InstalledHarnessInspection } from './installedCodexInspection.js'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { InstalledWorkflowConfigurationLocation } from '../runs/remote/installedWorkflowConfiguration.js'

export function inspectInstalledOpenCode(input: {
  binding: Readonly<DeviceSessionBinding>
  configuration: InstalledWorkflowConfigurationLocation | null
  environment: NodeJS.ProcessEnv
  cwd: string
  signal: AbortSignal
}): Promise<InstalledHarnessInspection> {
  return inspectInstalledHarness({ ...input, harness: 'opencode' })
}
