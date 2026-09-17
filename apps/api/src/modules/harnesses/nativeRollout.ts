import type { AgentHarness, OperatorConfigurationVersion } from '@graphql/contracts'
import { DomainError } from '../errors.js'

/** An exact provider version is necessary, but is not a production/parity approval. */
export class NativeRollout {
  constructor(private readonly environment: NodeJS.ProcessEnv) {}
  enabled(harness: AgentHarness): boolean {
    return harness === 'codex'
      ? this.environment.NODE_ENV !== 'production' && this.environment.GRAPHQL_ENABLE_EXPERIMENTAL_CODEX_APP_SERVER === '1'
      : this.environment.GRAPHQL_OPENCODE_PARITY_QUALIFIED === '1'
  }
  assertChat(configuration: OperatorConfigurationVersion): void {
    if (!this.enabled(configuration.harness.harness)) throw new DomainError('OPERATOR_NATIVE_CAPABILITY_DISABLED',
      configuration.harness.harness === 'codex'
        ? 'Persistent Codex chat requires an explicit experimental opt-in outside production; this provider is not production-qualified.'
        : 'Persistent OpenCode chat requires an explicit completed parity qualification. All workflow execution uses native sessions; there is no alternate execution transport.', 409)
  }
}
