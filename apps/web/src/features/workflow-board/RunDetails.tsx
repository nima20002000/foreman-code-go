import { useProtectedAccessError } from '../auth/useProtectedAccessError'
import { useEffect } from 'react'
import { create } from 'zustand'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { RepeatGraphScopeV3 } from '@graphql/contracts/wave25'
import { Alert, Badge, Button } from '../../shared/ui/nocturne'
import { assertSession, sessionGeneration } from '../../shared/api/sessionBoundary'
import { useBrowserAccessQuery } from '../../shared/api/settingsExperience'
import { useCurrentRunQuery, currentRunKey } from './currentRunQuery'
import { readPinnedRun, readPinnedRunVersion, verifyRunExecutionDetails } from './runDetailsClient'
import { recordBoardStopReceipt, reserveBoardStop, sendBoardStop, settleBoardStop, useBoardStopOutbox } from './stopOutbox'
import { canUseBoardAction } from './permissions'
import { RepeatStatus } from '../repeats/RepeatStatus'
import { RunHistory } from './RunHistory'
import { useWorkflowBoard } from './context'

const interaction = create<{ open: Record<string, boolean>; limit: Record<string, number>; toggle(key: string, value: boolean): void; more(key: string): void }>((set) => ({
  open: {}, limit: {}, toggle: (key, value) => set((state) => ({ open: { ...state.open, [key]: value } })),
  more: (key) => set((state) => ({ limit: { ...state.limit, [key]: (state.limit[key] ?? 50) + 50 } })),
}))
const json = (value: unknown) => JSON.stringify(value, null, 2)
export function CurrentRunDetails({ scope }: { scope: RepeatGraphScopeV3 }) {
  const canonical = useCurrentRunQuery(scope), cache = useQueryClient(), generation = sessionGeneration()
  const board = useWorkflowBoard(), access = useBrowserAccessQuery(), outbox = useBoardStopOutbox(scope)
  const identity = JSON.stringify([generation, scope]), detailsKey = ['workbench', 'pinned-v3-run-details', generation, scope.workspaceId, scope.workflowId, scope.runId, scope.workflowVersionId]
  const run = useQuery({ queryKey: detailsKey, queryFn: ({ signal }) => readPinnedRun(scope, { signal }), retry: false,
    refetchOnReconnect: 'always', refetchInterval: (query) => query.state.error ? false : query.state.data?.run.executionState !== 'completed' || query.state.data?.cleanupPending ? 1500 : false })
  const runDenied = useProtectedAccessError(run), canonicalDenied = useProtectedAccessError(canonical)
  const detail = run.isError || canonical.isError || runDenied || canonicalDenied ? undefined : run.data
  const pinned = useQuery({ queryKey: [...detailsKey, 'configuration'], enabled: !!detail,
    queryFn: ({ signal }) => readPinnedRunVersion(scope, detail!, { signal }), retry: false, staleTime: Infinity })
  const snapshot = canonical.isError || canonicalDenied || runDenied ? undefined : canonical.data
  const evidence = useQuery({ queryKey: [...detailsKey, 'evidence', canonical.data?.asOfSequence, run.dataUpdatedAt], enabled: !!snapshot && !!detail,
    queryFn: () => verifyRunExecutionDetails(snapshot!, detail!), retry: false, staleTime: Infinity })
  const limit = interaction((state) => state.limit[identity] ?? 50)
  const open = interaction((state) => state.open)
  const stop = useMutation({ retry: false, mutationFn: async () => {
    if (!snapshot || canonical.isError) throw new Error('Refresh the exact selected Run before Stop. No command was sent.')
    const journal = await reserveBoardStop(scope)
    const receipt = await sendBoardStop(journal)
    assertSession(generation)
    await recordBoardStopReceipt(journal, receipt)
    void cache.invalidateQueries({ queryKey: currentRunKey(scope) })
    void cache.invalidateQueries({ queryKey: detailsKey })
    return receipt
  } })
  const settlement = useMutation({ retry: false, mutationFn: async () => {
    const journal = outbox.journal
    if (journal && detail?.run.executionState === 'completed' && detail.cleanupPending === false && snapshot?.state.run.executionState === 'completed') {
      await settleBoardStop(scope, journal.request)
    }
  } })
  useEffect(() => {
    if (!outbox.journal?.receipt || outbox.journal.receipt.status === 'not_owner' || run.isError || canonical.isError
      || detail?.run.executionState !== 'completed' || detail.cleanupPending !== false || snapshot?.state.run.executionState !== 'completed'
      || settlement.isPending || settlement.isError) return
    settlement.mutate()
  }, [outbox.journal, detail, snapshot, run.isError, canonical.isError, settlement.isPending, settlement.isError, settlement.mutate])
  const principal = !access.isError ? access.data?.principal : undefined
  const permitted = !!principal && Date.parse(principal.expiresAt) > Date.now() && canUseBoardAction(principal.grants, 'runs:stop', scope)
  const receipt = outbox.journal?.receipt
  const canNeedStop = snapshot?.state.run.executionState !== 'completed' || detail?.cleanupPending !== false || !!outbox.journal
  const selectedNode = board?.inspection.runNodeId
  const selectedRelationship = board?.inspection.runRelationshipId
  const rows = evidence.isError || !detail || !snapshot ? [] : evidence.data?.filter((item) => !selectedNode || item.fact.identity.workflowNodeId === selectedNode) ?? []
  return <section aria-label="Pinned Run details" className="current-run-details">
    <header><Badge tone="neutral">Semantics 3</Badge><p>Run <code>{scope.runId}</code> · saved version <code>{scope.workflowVersionId}</code></p></header>
    {!snapshot ? <Alert tone="warning" title="Current Run state is unavailable.">No cached status, native acknowledgement or synthetic occurrence is used.
      <Button size="sm" onClick={() => void canonical.refetch()}>Refresh exact Run</Button></Alert> : <p role="status">
      Recorded {snapshot.state.run.executionState} · {snapshot.state.run.outcome} · complete cut {snapshot.asOfSequence}.
      {snapshot.state.run.stopRequested ? ' Stop requested; cleanup is not implied.' : ''}</p>}
    {run.isError ? <Alert tone="warning" title="Private Run details are unavailable."><Button size="sm" onClick={() => void run.refetch()}>Retry pinned details</Button></Alert> : null}
    {canNeedStop ? <div className="n-actions"><Button variant="danger" disabled={!permitted || !snapshot || stop.isPending || !!outbox.error}
      onClick={() => stop.mutate()}>{stop.isPending ? 'Sending exact Stop…' : outbox.journal ? 'Reconcile Stop' : 'Stop this Run'}</Button>
      {!permitted ? <span>Stop permission is unavailable for this exact Run.</span> : null}</div> : null}
    {outbox.error || stop.isError || settlement.isError ? <Alert tone="warning" title="Stop is not confirmed.">
      {outbox.error ?? stop.error?.message ?? settlement.error?.message} The original command is retained; no replacement Run is started.</Alert> : null}
    {receipt ? <p role="status">Stop receipt: {receipt.status}{receipt.replayed ? ' (replayed)' : ''}. {receipt.processStopped ? 'Native process closure was observed.' : 'Native process closure has not been confirmed.'}
      {' '}A Stop receipt is not cleanup settlement.</p> : null}
    {detail ? <dl><dt>Saved configuration pins</dt><dd><pre>{json(detail.run.agentConfigurationVersionIds)}</pre></dd>
      <dt>Accepted execution folder</dt><dd>{detail.run.executionLocation ? <pre>{json(detail.run.executionLocation)}</pre> : 'Restricted or unavailable; the current workspace folder is not substituted.'}</dd>
      <dt>Accepted Run input</dt><dd><pre>{json(detail.run.input)}</pre></dd>
      <dt>Cleanup</dt><dd>{detail.cleanupPending === true ? 'Pending' : detail.cleanupPending === false ? 'Settled according to authenticated Run readback' : 'Unknown'}</dd>
      {detail.run.result ? <><dt>Recorded Run result</dt><dd><pre>{json(detail.run.result)}</pre></dd></> : null}</dl> : null}
    <details onToggle={(event) => interaction.getState().toggle(`${identity}:configuration`, event.currentTarget.open)}>
      <summary>Exact saved definition and Agent configurations</summary>
      {pinned.isError ? <p role="alert">The immutable configuration could not be read. Current Agent settings are not substituted.</p> : null}
      {pinned.isPending ? <p role="status">Reading saved configuration pins…</p> : null}
      {open[`${identity}:configuration`] && detail && snapshot && pinned.data && !pinned.isError ? <><pre>{json(pinned.data.version)}</pre>
        {pinned.data.configurations.map((configuration) => <details key={configuration.id}><summary>Configuration {configuration.id}</summary><pre>{json(configuration)}</pre></details>)}</> : null}
    </details>
    {snapshot?.topology.repeat ? <RepeatStatus scope={scope} /> : null}
    {snapshot ? <section aria-label="Exact execution inputs and results">
      <header><h3>Execution inputs and accepted results</h3>{selectedNode || selectedRelationship ? <Button size="sm" onClick={() => board?.selectInspection({})}>Clear detail filter</Button> : null}</header>
      <div className="n-actions">{snapshot.topology.nodes.map((node) => <Button size="sm" key={node.workflowNodeId} aria-pressed={selectedNode === node.workflowNodeId}
        onClick={() => board?.selectInspection({ runNodeId: node.workflowNodeId })}>{node.workflowNodeId}</Button>)}</div>
      {evidence.isError ? <Alert tone="danger" title="Execution evidence did not match the pinned canonical cut.">No mismatched input or result is displayed.</Alert> : null}
      {evidence.isPending && detail ? <p role="status">Verifying exact execution and result digests…</p> : null}
      <ol>{rows.slice(0, limit).map(({ fact, execution, acceptedResult }) => {
        const id = fact.identity, key = `${identity}:execution:${id.executionId}`
        const bindings = snapshot.state.bindings.filter((binding) => binding.recipient.executionId === id.executionId && (!selectedRelationship || binding.relationshipId === selectedRelationship))
        return <li key={id.executionId}><strong>{id.workflowNodeId} · technical attempt {id.attempt}</strong>
          {id.occurrence ? <p>{id.occurrence.blockId} · business occurrence {id.occurrence.occurrenceIndex} · <code>{id.occurrence.occurrenceId}</code></p> : null}
          <p>Recorded {fact.state}{fact.resultOutcome ? ` · ${fact.resultOutcome}` : ''}. Execution <code>{id.executionId}</code>.</p>
          <details onToggle={(event) => interaction.getState().toggle(key, event.currentTarget.open)}><summary>Read this exact input and result</summary>
            {open[key] ? <><p>Input digest <code>{fact.inputDigest}</code>. Configuration <code>{id.agentConfigurationVersionId}</code>.</p>
              {execution ? <><pre aria-label={`Input ${id.executionId}`}>{json(execution.input)}</pre>
                <p>Native session: {execution.nativeSessionId ?? 'Not recorded'}</p></> : <p>Authorized detail for this exact execution is not available yet.</p>}
              {acceptedResult ? <pre aria-label={`Accepted result ${id.executionId}`}>{json(acceptedResult)}</pre> : <p>No accepted result detail is verified in this cut.</p>}
              <h4>Exact predecessor/result bindings</h4>{bindings.length ? <pre>{json(bindings)}</pre> : <p>No predecessor binding is recorded for this execution.</p>}</> : null}
          </details></li>
      })}</ol>
      {rows.length > limit ? <Button size="sm" onClick={() => interaction.getState().more(identity)}>Show more executions</Button> : null}
      {!rows.length && !evidence.isPending && !evidence.isError ? <p>No execution is recorded for this selection.</p> : null}
      <details><summary>Selected and unselected routing / joins</summary><pre>{json(snapshot.state.resolutions.filter((resolution) => !selectedNode || resolution.ref.nodeId === selectedNode))}</pre></details>
    </section> : null}
    {detail ? <RunHistory scope={scope} /> : null}
  </section>
}
