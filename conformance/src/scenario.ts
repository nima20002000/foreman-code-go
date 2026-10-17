import type { PublicHttpClient } from './clients/http.js'
import type { Lane } from './reporting/types.js'
import type { TargetSession } from './runtime/target.js'
import type { HttpTransport } from './coverage/http-routes.js'

export type CoverageClaim =
  | { surface: 'http'; method: string; path: string; transport?: HttpTransport; case: 'success' | 'error' }
  | { surface: 'mcp'; tool: string; case: 'success' | 'denied' | 'readback' }
  | { surface: 'stream'; name: string; case: 'framing' | 'order' | 'reconnect' }
  | { surface: 'workflow'; name: string; case: 'success' }
  | { surface: 'codec'; name: string; case: 'success' }

export interface ScenarioContext {
  target: TargetSession
  http: PublicHttpClient
  scenarioDirectory: string
  signal: AbortSignal
}

export interface Scenario {
  id: string
  title: string
  lane: Lane
  covers?: readonly CoverageClaim[]
  authentication?: 'local-human' | 'operator'
  timeoutMs?: number
  run(context: ScenarioContext): Promise<void>
}
