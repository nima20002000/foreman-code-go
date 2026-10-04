import { readProductEnvironment } from '@foreman-code/contracts/product-environment'
import type { AgentHarness, OperatorConfigurationVersion } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'

/** An exact provider version is necessary, but is not a production/parity approval. */
export class NativeRollout {
  constructor(private readonly environment: NodeJS.ProcessEnv) {}
  enabled(harness: AgentHarness): boolean {
    const selected = harness === 'codex' ? readProductEnvironment(this.environment, 'ENABLE_EXPERIMENTAL_CODEX_APP_SERVER')
      : harness === 'claude' ? readProductEnvironment(this.environment, 'ENABLE_EXPERIMENTAL_CLAUDE_SDK')
        : readProductEnvironment(this.environment, 'OPENCODE_PARITY_QUALIFIED')
    const local = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(this.environment.HOST ?? '127.0.0.1')
    if (this.environment.NODE_ENV === 'production') {
      if (readProductEnvironment(this.environment, 'LOCAL_PRODUCTION') !== '1') return harness === 'opencode' && selected === '1'
      try {
        const database = new URL(this.environment.DATABASE_URL ?? '')
        const localDatabase = ['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname)
        if (!local || !localDatabase) return false
      } catch {
        return false
      }
    }
    // Supported local harnesses still pass native version, account, model,
    // approval and sandbox qualification at every execution admission.
    return selected === '1' || (selected === undefined && local)
  }
  assertChat(configuration: OperatorConfigurationVersion): void {
    if (!this.enabled(configuration.harness.harness)) throw new DomainError('OPERATOR_NATIVE_CAPABILITY_DISABLED',
      configuration.harness.harness === 'codex'
        ? 'Codex execution is disabled for this runtime. Supported local installations enable it by default; native qualification remains required.'
        : configuration.harness.harness === 'claude'
          ? 'Claude execution is disabled for this runtime. Supported local installations enable it by default; host native qualification remains required.'
          : 'OpenCode execution is disabled for this runtime. Supported local installations enable it by default; native qualification remains required.', 409)
  }
}
