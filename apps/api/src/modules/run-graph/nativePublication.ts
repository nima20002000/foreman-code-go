import { readPublicProjectionLocked } from './compactSnapshot.js'
import type { HarnessNativeEvent } from '@foreman-code/contracts'
import type { RunGraphScope } from '@foreman-code/contracts/wave25'
import type { ExclusiveGraphConnection } from './connection.js'
import { withRunGraphPublication } from './publication.js'
import { appendNativeGraphEvent, type NativeGraphWork } from './nativeIngestion.js'
import { observeGraph, type GraphMeasurementSink } from './measurements.js'

/** Convenience for an existing runtime owner's exclusive connection. Does not acquire an owner. */
export async function publishNativeGraphEvent(connection: ExclusiveGraphConnection, scope: RunGraphScope,
  event: HarnessNativeEvent, work: readonly NativeGraphWork[], measurements?: GraphMeasurementSink) {
  const start = performance.now()
  let projectionMs = 0
  try {
    const result = await withRunGraphPublication(connection, scope, async (publication) => {
      const projectionStart = performance.now()
      const value = await appendNativeGraphEvent(publication, event, work)
      projectionMs = performance.now() - projectionStart
      return value
    }, readPublicProjectionLocked)
    // Instrumentation runs AFTER COMMIT, outside the publication/ownership critical section.
    observeGraph(measurements, { stage: 'projection', outcome: result.value.rejected ? 'rejected' : result.value.projected ? 'ok' : 'ignored',
      durationMs: projectionMs, rows: result.value.projected })
    observeGraph(measurements, { stage: 'publication', outcome: 'ok', durationMs: performance.now() - start })
    return result
  } catch (error) {
    observeGraph(measurements, { stage: 'publication', outcome: 'error', durationMs: performance.now() - start })
    throw error // No retry: an uncertain COMMIT/native submission must be reconciled by the runtime owner.
  }
}
