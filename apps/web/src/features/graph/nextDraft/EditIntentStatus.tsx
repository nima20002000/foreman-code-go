import type { GraphEditReadResult } from '@graphql/contracts/wave25'

/** Required recovery controls stay on the V1 board, never in a second Run page. */
export function EditIntentStatus({ data }: { data: GraphEditReadResult }) {
  const intent = data.intent
  if (!intent) return null
  return <section className="next-draft-section board-edit-intent" aria-label="Retained edits and affected Runs">
    <h2>Retained edits · {intent.state}</h2>
    <p>Intent <code>{intent.id}</code> · draft revision {intent.expectedRevision} · saved version <code>{intent.expectedWorkflowVersionId ?? 'none'}</code></p>
    {intent.state === 'saved' ? <p role="status">Saved as <code>{intent.result?.version.id}</code>. No Run was restarted. Historical Run pins are unchanged.</p>
      : intent.state === 'discarded' ? <p role="status">The private edit intent was discarded. Discard did not issue Stop or change independent layout.</p>
      : <p role="status">Stop acceptance is not settlement. Publication waits for terminal outcome and all native, interaction, review and cleanup obligations.</p>}
    {intent.error ? <p role="alert">{intent.error.code}: {intent.error.message}</p> : null}
    {data.affectedSetChanged ? <p role="alert">The exact affected Run set changed. This intent cannot Stop newly discovered Runs or publish over them.</p> : null}
    {!data.canStop && data.current.some((item) => !item.settled) ? <p role="alert">Stop permission is required for every unsettled affected Run.</p> : null}
    <details><summary>Affected workflow and shared-Agent Runs ({data.current.length})</summary>
      <p>The board-selected Run is navigation only. The authenticated server plan determines this full set.</p>
      {data.current.map((item) => {
        const stop = intent.stops.find((entry) => entry.input.runId === item.pin.runId)
        return <p key={item.pin.runId}><code>{item.pin.workflowId}</code> / <code>{item.pin.runId}</code> / version <code>{item.pin.workflowVersionId}</code>
          {' · '}{item.settled ? 'settled' : item.terminal ? 'terminal, settlement pending' : 'not terminal'} · {item.outcome}
          {item.nativePending ? ' · native pending' : ''}{item.interactionPending ? ' · interaction pending' : ''}
          {item.reviewPending ? ' · review pending' : ''}{item.cleanupPending ? ' · cleanup pending' : ''}
          {stop ? <> · Stop command <code>{stop.input.commandId}</code>: {stop.receipt?.status ?? 'no acknowledged receipt'}</> : ' · no Stop command planned'}
        </p>
      })}
    </details>
    <details><summary>Exact staged payload and command journal</summary>
      <pre>{JSON.stringify({ stagedDraft: intent.stagedDraft, agentPins: intent.agentPins, affected: intent.affected,
        stageCommandId: intent.stageCommandId, stageInputHash: intent.stageInputHash,
        advanceCommandId: intent.advanceCommandId, advanceInputHash: intent.advanceInputHash,
        discardCommandId: intent.discardCommandId, discardInputHash: intent.discardInputHash,
        stops: intent.stops, saveInput: intent.saveInput, saveInputHash: intent.saveInputHash }, null, 2)}</pre>
    </details>
  </section>
}
