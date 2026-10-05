import type { ChildProcessEnvironment } from '../../src/modules/harnesses/port.js'
import { ManagedOpenCodeServer } from '../../src/modules/harnesses/opencodeTransport.js'

/** Records the production HTTP boundary without replacing native responses. */
export class RecordedOpenCodeServer extends ManagedOpenCodeServer {
  readonly calls: Array<{ path: string; method: string; body?: Record<string, unknown> }> = []
  readonly restartEnvironments: ChildProcessEnvironment[] = []

  override async request(path: string, init: RequestInit = {}, signal?: AbortSignal, generation?: number) {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined
    this.calls.push({ path, method: init.method ?? 'GET', ...(body ? { body } : {}) })
    return super.request(path, init, signal, generation)
  }

  override async restart(environment: ChildProcessEnvironment, signal?: AbortSignal) {
    this.restartEnvironments.push(structuredClone(environment))
    await super.restart(environment, signal)
  }
}
