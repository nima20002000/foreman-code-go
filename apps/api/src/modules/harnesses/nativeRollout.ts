import type { AgentHarness, OperatorConfigurationVersion } from '@graphql/contracts'
import { DomainError } from '../errors.js'

/** An exact provider version is necessary, but is not a production/parity approval. */
export class NativeRollout {
  constructor(private readonly environment: NodeJS.ProcessEnv) {}
  enabled(harness: AgentHarness): boolean {
    const selected = harness === 'codex' ? this.environment.GRAPHQL_ENABLE_EXPERIMENTAL_CODEX_APP_SERVER
      : this.environment.GRAPHQL_OPENCODE_PARITY_QUALIFIED
    if (this.environment.NODE_ENV === 'production') return harness === 'opencode' && selected === '1'
    const local = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(this.environment.HOST ?? '127.0.0.1')
    // Supported local harnesses still pass native version, account, model,
    // approval and sandbox qualification at every execution admission.
    return selected === '1' || (selected === undefined && local)
  }
  assertChat(configuration: OperatorConfigurationVersion): void {
    if (!this.enabled(configuration.harness.harness)) throw new DomainError('OPERATOR_NATIVE_CAPABILITY_DISABLED',
      configuration.harness.harness === 'codex'
        ? 'Codex execution is disabled for this runtime. Supported local development enables it by default; explicit disables and production restrictions remain in effect.'
        : 'OpenCode execution is disabled for this runtime. Supported local development enables it by default; explicit disables and production qualification remain in effect.', 409)
  }
}
