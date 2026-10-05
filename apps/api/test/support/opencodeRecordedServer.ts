import type { ChildProcessEnvironment } from '../../src/modules/harnesses/port.js'
import { ManagedOpenCodeServer } from '../../src/modules/harnesses/opencodeTransport.js'

/** Records the production HTTP boundary without replacing native responses. */
export class RecordedOpenCodeServer extends ManagedOpenCodeServer {
  readonly calls: Array<{ path: string; method: string; body?: Record<string, unknown> }> = []
  readonly restartEnvironments: ChildProcessEnvironment[] = []
  onPromptAccepted?: () => void

  override async request(path: string, init: RequestInit = {}, signal?: AbortSignal, generation?: number) {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined
    this.calls.push({ path, method: init.method ?? 'GET', ...(body ? { body } : {}) })
    const response = await super.request(path, init, signal, generation)
    if (response.ok && new URL(path, 'http://native.invalid').pathname.endsWith('/prompt_async')) {
      this.onPromptAccepted?.()
    }
    return response
  }

  override async restart(environment: ChildProcessEnvironment, signal?: AbortSignal) {
    this.restartEnvironments.push(structuredClone(environment))
    await super.restart(environment, signal)
  }
}
