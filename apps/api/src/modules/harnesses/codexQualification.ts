import type { CodexHarnessConfiguration } from '@foreman-code/contracts'

import { HarnessExecutionError } from './errors.js'
import { isObject, object, type JsonObject } from './codexStdioTransport.js'
import { runCommand } from './process.js'
import type { NativeProcessRecovery } from './recovery/processRegistry.js'

/** Model-free inspection shared by app-server admission and configuration checks. */
export async function qualifyNativeCodexModel(
  configuration: CodexHarnessConfiguration,
  binary: string,
  workingDirectory: string,
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  recovery?: NativeProcessRecovery,
): Promise<void> {
  const result = await runCommand(binary, ['debug', 'models'], workingDirectory, signal, environment, recovery ? { recovery } : {})
  if (result.exitCode !== 0) throw new HarnessExecutionError('CODEX_MODEL_CATALOG_UNAVAILABLE', 'Codex model qualification failed.')
  let catalog: JsonObject
  try { catalog = object(JSON.parse(result.stdout)) }
  catch { throw new HarnessExecutionError('CODEX_MODEL_CATALOG_INVALID', 'Codex returned an invalid model catalog.') }
  const models = Array.isArray(catalog.models) ? catalog.models.filter(isObject) : []
  const model = models.find((entry) => entry.slug === configuration.model)
  if (!model) throw new HarnessExecutionError('CODEX_MODEL_UNAVAILABLE', 'The accepted Codex model is unavailable.')
  const efforts = Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels.filter(isObject) : []
  const tiers = Array.isArray(model.additional_speed_tiers) && model.additional_speed_tiers.every((tier) => typeof tier === 'string')
    ? model.additional_speed_tiers : []
  if (!efforts.some((effort) => effort.effort === configuration.reasoningEffort)
    || (configuration.serviceTier === 'priority' && !tiers.includes('fast'))) {
    throw new HarnessExecutionError('CODEX_SETTING_UNSUPPORTED', 'The selected model does not advertise the requested effort or service tier.')
  }
}
