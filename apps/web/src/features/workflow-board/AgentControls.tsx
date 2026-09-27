import { storeEditSnapshot } from '../graph/nextDraft/editIntentStorage'
import type { Agent, GraphqlToolOverride } from '@graphql/contracts'
import { useAgentDefaultsQuery } from '../../shared/api/query'
import { Alert, Button, Icon } from '../../shared/ui/nocturne'
import { defaultAgentForHarness } from '../agents/agentSettings'
import { useGraphDraftStore } from '../graph/store'
import { AgentSettingsForm } from '../graph/AgentSettingsForm'
import { changeDraftAgent, editorAgents } from '../graph/nextDraft/agentEdits'
import type { NextDraftEdit } from '../graph/nextDraft/state'

function installAgent(draftKey: string, instanceId: string, agent: Agent, nodeId?: string, prompt?: string, graphqlTools?: GraphqlToolOverride) {
  useGraphDraftStore.getState().updateNextDraft(draftKey, (current) => {
    if (current.instanceId !== instanceId) throw new Error('The draft instance changed. Reopen these settings.')
    const graph = current.graph
    const node = nodeId ? graph.nodes.find((item) => item.id === nodeId && item.agentId === agent.id) : undefined
    if (nodeId && !node) throw new Error('This Agent node is no longer in the draft.')
    const id = node?.id ?? `node-${crypto.randomUUID()}`
    const kept = node ? { ...node } : undefined
    if (kept) delete kept.graphqlTools
    const nextNode = kept ? { ...kept, name: agent.name, initialPrompt: prompt, ...(graphqlTools ? { graphqlTools } : {}) } : {
      id, agentId: agent.id, name: agent.name,
      position: { x: 80 + graph.nodes.length % 4 * 320, y: 100 + Math.floor(graph.nodes.length / 4) * 300 },
    }
    const agentForms = { ...current.agentForms }; delete agentForms[id]
    return changeDraftAgent({ ...current, agentForms }, agent, { ...graph,
      nodes: node ? graph.nodes.map((item) => item.id === id ? nextNode : item) : [...graph.nodes, nextNode],
      entryNodeId: !graph.nodes.length ? id : graph.entryNodeId,
    })
  })
}

export function NewBoardAgent({ draftKey, edit, report }: { draftKey: string; edit: NextDraftEdit; report(error: unknown): void }) {
  const defaults = useAgentDefaultsQuery()
  return <section className="next-draft-section" aria-label="Create board Agent">
    {defaults.isError ? <Alert tone="danger" title="Agent defaults could not be loaded."
      action={<Button size="sm" onClick={() => void defaults.refetch()}>Try again</Button>} /> : null}
    <div className="board-new-agent">{(['orchestrator', 'coder'] as const).map((role) => <Button key={role} variant="secondary"
      leading={<Icon name={role === 'orchestrator' ? 'workflow' : 'code'} size={18} />}
      disabled={!defaults.data || defaults.isError || edit.busy || !!edit.pending}
      onClick={() => {
        const saved = defaults.data?.value[role]
        if (!saved) return
        const workers = editorAgents(edit).filter((item) => item.productRole === 'coder' && edit.graph.nodes.some((node) => node.agentId === item.id)).length
        const name = role === 'orchestrator' ? 'Orchestrator' : `Worker ${workers + 1}`
        try { installAgent(draftKey, edit.instanceId, defaultAgentForHarness(saved.harness.harness,
          `agent-${crypto.randomUUID()}`, name, saved.harness, role)) } catch (error) { report(error) }
      }}>{role === 'orchestrator' ? 'Orchestrator' : 'Worker'}</Button>)}</div>
  </section>
}

export function BoardAgentSettings({ draftKey, edit, nodeId, close, remove }: { draftKey: string; edit: NextDraftEdit; nodeId: string; close(): void; remove?(): void }) {
  const node = edit.graph.nodes.find((item) => item.id === nodeId)
  const agent = node && editorAgents(edit).find((item) => item.id === node.agentId)
  if (!node || !agent) return <Alert tone="warning" title="This agent’s settings aren’t available." />
  // Re-key on the staged agent so a discard or reload never leaves stale values in the open form.
  return <AgentSettingsForm key={`${edit.instanceId}:${node.id}:${JSON.stringify(agent)}:${node.initialPrompt ?? ''}:${JSON.stringify(node.graphqlTools ?? null)}`} embedded agent={agent} initialPrompt={node.initialPrompt}
    nodeGraphqlTools={node.graphqlTools}
    retainedForm={edit.agentForms?.[node.id]}
    onFormChange={(form) => useGraphDraftStore.getState().updateNextDraft(draftKey, (current) => ({ ...current,
      agentForms: { ...current.agentForms, [node.id]: form } }))}
    onDiscardForm={() => useGraphDraftStore.getState().updateNextDraft(draftKey, (current) => {
      const agentForms = { ...current.agentForms }; delete agentForms[node.id]
      return { ...current, agentForms }
    })}
    canResume={() => {
      const current = useGraphDraftStore.getState().nextDrafts[draftKey]
      if (!current) return false
      try { storeEditSnapshot(draftKey, current); return true } catch { return false }
    }}
    workspaceId={edit.graph.workspaceId} workflowApprovalHandler={edit.graph.approval?.handler}
    designatedOrchestrator={edit.graph.approval?.handler === 'orchestrator' && edit.graph.approval.designatedOrchestratorAgentId === agent.id}
    executionPolicy={edit.graph.executionPolicy} onClose={close} onRemove={remove}
    onSave={(next, prompt, _policy, graphqlTools) => installAgent(draftKey, edit.instanceId, next, node.id, prompt, graphqlTools)} />
}
