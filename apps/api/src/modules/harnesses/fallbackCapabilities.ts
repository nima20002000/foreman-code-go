import { isDeepStrictEqual } from 'node:util'

import {
  DEFAULT_CODEX_ADVANCED_CONFIGURATION,
  DEFAULT_OPENCODE_ADVANCED_CONFIGURATION,
  HarnessConfigurationSchema,
  type HarnessConfiguration,
} from '@graphql/contracts'

import { HarnessExecutionError } from './errors.js'

/** CLI fallback supports the existing basic settings, not the deferred native-session controls. */
export function assertFallbackConfiguration(input: HarnessConfiguration): void {
  const configuration = HarnessConfigurationSchema.parse(input)
  if (configuration.harness === 'opencode' && configuration.autoApprove) {
    throw new HarnessExecutionError('OPENCODE_SETTING_UNSUPPORTED', 'Automatic permission approval is disabled for Product Agent runs.')
  }
  if (!configuration.advanced) return
  const defaults = configuration.harness === 'codex'
    ? DEFAULT_CODEX_ADVANCED_CONFIGURATION : DEFAULT_OPENCODE_ADVANCED_CONFIGURATION
  // Defaults are a compatible opt-in to the existing fallback behavior, not proof
  // that native-session capabilities exist. Never silently accept changed controls.
  const baseline = defaults as unknown as Record<string, unknown>
  const unsupported = Object.entries(configuration.advanced)
    .filter(([key, value]) => !isDeepStrictEqual(value, baseline[key]))
    .map(([key]) => `advanced.${key}`)
  if (unsupported.length > 0) {
    throw new HarnessExecutionError(
      'HARNESS_ADVANCED_UNSUPPORTED',
      `${configuration.harness} CLI fallback cannot enforce ${unsupported.join(', ')}. Restore those defaults or use a qualified native-session transport.`,
    )
  }
}
