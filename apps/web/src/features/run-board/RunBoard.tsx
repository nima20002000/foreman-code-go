import type { SelectedRunState } from '../runs-selector/useSelectedRun'
import { runReadErrorLabel, useSelectedRunSnapshot } from '../runs-selector/query'
import { RunBoardCanvas } from './RunBoardCanvas'
import './runBoard.css'

export type RunBoardProps = { selection: SelectedRunState }

/** Accept the SAME selected-Run hook result as RunsSelector, including its visit
 * generation. A naked runId loses the A -> B -> A fence. Query owns every read.
 */
export function RunBoard({ selection }: RunBoardProps) {
  const query = useSelectedRunSnapshot(selection)
  if (!selection.active) return null
  if (selection.invalid) return <section className="run-board" aria-label="Selected Run board"><p role="status">Invalid Run</p></section>
  if (selection.identity.runId === null) return null

  const current = selection.isCurrent(selection.generation)
  const snapshot = current ? query.snapshot : undefined
  const failed = current && query.isError
  const loading = !failed && !snapshot
  return <section className="run-board" aria-label="Selected Run board" aria-busy={loading}
    data-run-id={selection.identity.runId} data-generation={selection.generation.id}>
    {failed ? <div className="run-board-message" role="status">
      <span>{runReadErrorLabel(query.error)}</span>
      <button type="button" onClick={() => {
        if (selection.isCurrent(selection.generation)) void query.refetch()
      }}>Retry</button>
    </div> : loading ? <p role="status">{query.isPaused ? 'Offline' : 'Loading…'}</p>
      : snapshot?.kind === 'unavailable' ? <p role="status">Snapshot unavailable</p>
      : snapshot?.kind === 'available' ? <>
        <span className="run-board-label">Read only</span>
        {snapshot.nodes.length ? <RunBoardCanvas key={selection.generation.id} snapshot={snapshot} /> : <p role="status">No nodes</p>}
      </> : null}
  </section>
}
