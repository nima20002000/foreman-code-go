import type { HarnessConfiguration } from '@graphql/contracts'
import { DomainError } from '../../errors.js'

/** Main production has no authorized host/profile API-key delivery source.
 * Saved settings and native proof cannot supply a secret or authorize ambient authentication. */
export function requireClaudeProductionCredentialDelivery(configuration: HarnessConfiguration): void {
  if (configuration.harness === 'claude' && configuration.authMode === 'api-key') {
    throw new DomainError('CLAUDE_API_KEY_DELIVERY_UNAVAILABLE',
      'Claude API-key execution requires authorized host/profile credential delivery, which is not configured. This profile cannot be qualified or launched; inherited ANTHROPIC_API_KEY is never used.', 409)
  }
}
