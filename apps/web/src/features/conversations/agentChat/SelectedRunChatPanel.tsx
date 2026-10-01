import { useCallback, useEffect, useId, useLayoutEffect, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { create } from 'zustand'
import type { AgentChatContext } from '@graphql/contracts/agent-chat'
import type { ReadSelectedRunChatResponse, SelectedRunChatSelection } from '@graphql/contracts/selected-run-chat'
import type { RunBoardNodeSnapshot, RunBoardSnapshot } from '@graphql/contracts/run-snapshots'
import { Button, Select, TextField } from '../../../shared/ui/nocturne'
import { ApiError } from '../../../shared/api/client'
import { sessionGeneration } from '../../../shared/api/sessionBoundary'
import type { SelectedRunState } from '../../runs-selector/useSelectedRun'
import { runReadErrorLabel, useSelectedRunSnapshot } from '../../runs-selector/query'
import { Activities } from '../../workflow-board/Activities'
import { useConversationDraftStore } from '../conversationDraftStore'
import { AgentConversation } from './AgentConversation'
import { selectedRunChatApi } from './selectedRunChatClient'
import { createChatVisit, resolvedSelectedChatKey, selectedChatDraftKey, stateMatchesSelectedChat, type SelectedChatBinding } from './selectedRunChatModel'
import './selectedRunChat.css'

// These are transient controls inside the chat panel, not a copy of URL Run selection.
// An execution is chosen explicitly; no "latest execution" fallback is stored here.
type PanelChoice = { nodeId?: string; executionId?: string; revision: number }
const emptyChoice: PanelChoice = { revision: 0 }
const usePanelChoice = create<{ choices: Record<string, PanelChoice>; choose(key: string, nodeId: string, executionId?: string): void; close(key: string): void }>((set) => ({
  choices: {},
  choose: (key, nodeId, executionId) => set((state) => ({ choices: { ...state.choices,
    [key]: { nodeId, executionId, revision: (state.choices[key]?.revision ?? 0) + 1 } } })),
  close: (key) => set((state) => { const choices = { ...state.choices }; delete choices[key]; return { choices } }),
}))

/** The snapshot, never today's Agent list, supplies the selectable agents and names. */
export function SelectedRunChatPanel({ selection, workflowNodeId }: { selection: SelectedRunState; workflowNodeId?: string }) {
  const snapshot = useSelectedRunSnapshot(selection)
  if (!selection.active) return null
  if (selection.invalid) return <p role="status">Invalid Run</p>
  if (!selection.isCurrent(selection.generation)) return null
  if (selection.identity.runId === null) return null
  if (snapshot.isError) return <p role="status">{runReadErrorLabel(snapshot.error)} <Button size="sm" onClick={() => {
    if (selection.isCurrent(selection.generation)) void snapshot.refetch()
  }}>Retry</Button></p>
  if (!snapshot.snapshot) return <p role="status">Loading…</p>
  if (snapshot.snapshot.kind === 'unavailable') return <p role="status">Snapshot unavailable</p>
  return <SnapshotAgents key={`${selection.generation.id}:${workflowNodeId ?? ''}`} selection={selection} snapshot={snapshot.snapshot} workflowNodeId={workflowNodeId} />
}

function SnapshotAgents({ selection, snapshot, workflowNodeId }: { selection: SelectedRunState; snapshot: Extract<RunBoardSnapshot, { kind: 'available' }>; workflowNodeId?: string }) {
  const instance = useId()
  const panelKey = JSON.stringify([selection.identity, selection.generation.id, instance])
  const choice = usePanelChoice((state) => state.choices[panelKey]) ?? emptyChoice
  useEffect(() => () => usePanelChoice.getState().close(panelKey), [panelKey])
  const requestedNode = choice.nodeId ?? workflowNodeId
  const node = requestedNode ? snapshot.nodes.find((item) => item.id === requestedNode) : snapshot.nodes[0]
  const current = useCallback(() => selection.isCurrent(selection.generation)
    && (usePanelChoice.getState().choices[panelKey]?.revision ?? 0) === choice.revision,
  [selection, panelKey, choice.revision])
  const choose = (nodeId: string, executionId?: string) => {
    if (current()) usePanelChoice.getState().choose(panelKey, nodeId, executionId)
  }
  return <section className="selected-run-chat" aria-label="Selected Run chat" data-run-id={snapshot.runId}>
    <Select label="Agent" value={node?.id ?? ''} options={[...(!node ? [{ value: '', label: 'Select agent' }] : []),
      ...snapshot.nodes.map((item) => ({ value: item.id, label: item.name }))]}
      onChange={(event) => choose(event.currentTarget.value)} />
    {node ? <ResolveSelectedChat key={`${node.id}:${choice.revision}`} selection={selection} node={node}
      executionId={choice.executionId} isCurrent={current} onExecution={(id) => choose(node.id, id)} /> : <p role="status">{snapshot.nodes.length ? 'Agent unavailable' : 'No agents'}</p>}
  </section>
}

// A lookup retains only identity, not a second AgentChatState. The existing chat query
// owns transcript/capabilities/turns and re-reads the exact resolved execution.
type SelectedIdentity = Pick<Extract<ReadSelectedRunChatResponse, { kind: 'selected' }>, 'kind' | 'selection' | 'key'> & { context: AgentChatContext }
type Lookup = SelectedIdentity | Exclude<ReadSelectedRunChatResponse, { kind: 'selected' }>

function ResolveSelectedChat({ selection, node, executionId, isCurrent, onExecution }: {
  selection: SelectedRunState; node: RunBoardNodeSnapshot; executionId?: string; isCurrent(): boolean; onExecution(id?: string): void
}) {
  const cache = useQueryClient(), instance = useId(), generation = sessionGeneration()
  const visit = useMemo(() => createChatVisit(isCurrent), [isCurrent])
  useEffect(() => visit.mount(), [visit])
  const request = useMemo<SelectedRunChatSelection>(() => ({ workspaceId: selection.identity.workspaceId,
    workflowId: selection.identity.workflowId, runId: selection.identity.runId!, workflowNodeId: node.id,
    ...(executionId ? { executionId } : {}) }), [selection.identity.workspaceId, selection.identity.workflowId, selection.identity.runId, node.id, executionId])
  const visitId = `${selection.generation.id}:${instance}`
  const lookupKey = useMemo(() => ['agent-chat', generation, 'selected-identity', visitId, request] as const, [generation, visitId, request])
  const lookup = useQuery<Lookup>({ queryKey: lookupKey, retry: false, staleTime: Infinity, gcTime: 0,
    refetchOnWindowFocus: false, refetchOnReconnect: false,
    queryFn: async ({ signal }) => {
      const current = visit.capture()
      if (!current()) throw new DOMException('Selection changed', 'AbortError')
      const result = await selectedRunChatApi.read(request, { signal })
      if (!current() || signal.aborted) throw new DOMException('Selection changed', 'AbortError')
      if (result.kind !== 'selected') return result
      if (result.state.context.agentId !== node.agentId) throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Agent identity changed.' })
      return { kind: result.kind, selection: result.selection, key: result.key, context: result.state.context }
    },
  })
  const identity = !lookup.isError && visit.isCurrent() && lookup.data?.kind === 'selected' ? lookup.data : undefined
  const binding = useMemo<SelectedChatBinding | undefined>(() => identity ? {
    selection: identity.selection, key: identity.key, visitId,
    isCurrent: () => {
      const current = cache.getQueryData<Lookup>(lookupKey)
      return visit.isCurrent() && current?.kind === 'selected' && current.selection.executionId === identity.selection.executionId
        && current.key?.conversationId === identity.key?.conversationId
    },
    onConversation: (state) => {
      if (!visit.isCurrent() || identity.key || !stateMatchesSelectedChat(state, identity.context, identity)) return
      const key = resolvedSelectedChatKey(identity.selection, state)
      if (!key) return
      cache.setQueryData<Lookup>(lookupKey, (previous) => previous?.kind === 'selected' && !previous.key
        && previous.selection.executionId === identity.selection.executionId ? { ...previous, key } : previous)
    },
  } : undefined, [identity, visitId, cache, lookupKey, visit])
  useLayoutEffect(() => {
    if (!binding?.key || !binding.isCurrent()) return
    // Preserve text edited during creation. The hook settles an unchanged submitted draft
    // before promotion; a return after a lost response settles it from fresh readback.
    const store = useConversationDraftStore.getState()
    const from = selectedChatDraftKey(binding.selection, binding.key.agentId, null)
    const to = selectedChatDraftKey(binding.selection, binding.key.agentId, binding.key.conversationId)
    const draft = store.drafts[from]
    if (draft === undefined || store.drafts[to] !== undefined) return
    store.setDraft(to, draft)
    store.clearDraft(from, draft)
  }, [binding])
  if (!visit.isCurrent()) return null
  if (lookup.isError) return <p role="status">{runReadErrorLabel(lookup.error)} <Button size="sm" onClick={() => {
    if (visit.isCurrent()) void lookup.refetch()
  }}>Retry</Button></p>
  if (!lookup.data) return <p role="status">Loading…</p>
  if (lookup.data.kind === 'unavailable') return <p role="status">{lookup.data.reason === 'legacy_run' ? 'Snapshot unavailable' : 'Execution unavailable'}</p>
  if (lookup.data.kind === 'execution_selection_required') return <div className="selected-chat-execution">
    <Select label="Execution" value="" options={[{ value: '', label: 'Select execution' }, ...lookup.data.executions.map((item) => ({
      value: item.executionId, label: `Attempt ${item.attempt} · ${item.executionId.slice(-8)}`,
    }))]} onChange={(event) => { if (visit.isCurrent() && event.currentTarget.value) onExecution(event.currentTarget.value) }} />
    {lookup.data.hasMoreExecutions ? <form onSubmit={(event) => {
      event.preventDefault()
      const id = String(new FormData(event.currentTarget).get('executionId') ?? '').trim()
      if (visit.isCurrent() && id) onExecution(id)
    }}><TextField name="executionId" label="Execution ID" placeholder="Execution ID" required maxLength={200} />
      <Button size="sm" type="submit">Open</Button></form> : null}
  </div>
  if (!identity || !binding) return null
  return <div key={binding.key?.conversationId ?? 'before-conversation'} data-execution-id={identity.selection.executionId}>
    <Button size="sm" variant="ghost" aria-label="Choose execution" title={identity.selection.executionId}
      onClick={() => { if (binding.isCurrent()) onExecution() }}>Execution</Button>
    <AgentConversation key={`${visitId}:${binding.key?.conversationId ?? 'none'}`} name={node.name} context={identity.context} selected={binding} />
    <Activities selection={selection} chat={binding} />
  </div>
}
