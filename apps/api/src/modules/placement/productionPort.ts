import type pg from 'pg'
import type { WorkerObservation } from '@foreman-code/contracts/node-placement'
import type { NativeHarnessSessionManager } from '../harnesses/port.js'
import type { NativeMcpInspector } from '../harnesses/mcpDetection.js'
import type { NativeManagerResolutionContext } from '../interactions/runtimePorts.js'
import type { RunPlacementAdmissionPort } from './startPort.js'
import type { AcceptedDestinationContinuation } from './continuation.js'
import type { AcceptedExecutionBinding } from './nativeComposition.js'
import type { PlacementChoiceDiscovery } from './choicesService.js'

/** Trusted actual W07/W08-B/W09 composition. All callbacks are required: this
 * cannot be installed with a connection-only worker or caller-provided proof. */
export interface ProductionPlacementComposition {
  mainId: string
  admission: RunPlacementAdmissionPort
  destination: AcceptedDestinationContinuation
  choices: PlacementChoiceDiscovery
  createRemoteManager(context: NativeManagerResolutionContext, binding: AcceptedExecutionBinding): NativeHarnessSessionManager
  inspector(manager: NativeHarnessSessionManager, binding: AcceptedExecutionBinding): NativeMcpInspector
  /** Exact selected-main worker carrier endpoint, not the worker's app API. */
  appMcpEndpoint(binding: AcceptedExecutionBinding): string
  /** Synchronous allocation only; worker journal reserves native entry itself. */
  reserveRemoteLaunch(executionId: string, manager: NativeHarnessSessionManager, binding: AcceptedExecutionBinding): void
  /** True only with exact physical process closure evidence from original host. */
  closeRemoteExecution(executionId: string, binding: AcceptedExecutionBinding, signal: AbortSignal): Promise<boolean>
  readObservations(client: pg.PoolClient, runId: string, nodeId: string): Promise<readonly WorkerObservation[]>
}
