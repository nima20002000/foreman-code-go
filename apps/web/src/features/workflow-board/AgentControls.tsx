import type { Agent } from '@graphql/contracts'
import { useAgentDefaultsQuery } from '../../shared/api/query'
import { Button } from '../../shared/ui/nocturne'
import { defaultAgentForHarness } from '../agents/agentSettings'
import { useGraphDraftStore } from '../graph/store'
import { AgentSettingsForm } from '../graph/AgentSettingsForm'
import { changeDraftAgent, editorAgents } from '../graph/nextDraft/agentEdits'
import type { NextDraftEdit } from '../graph/nextDraft/state'

function installAgent(draftKey: string, instanceId: string, agent: Agent, nodeId?: string, prompt?: string) {
  useGraphDraftStore.getState().updateNextDraft(draftKey, (current) => {
    if (current.instanceId !== instanceId) throw new Error('The draft instance changed. Reopen these settings.')
    const graph = current.graph
    const node = nodeId ? graph.nodes.find((item) => item.id === nodeId && item.agentId === agent.id) : undefined
    if (nodeId && !node) throw new Error('This Agent node is no longer in the draft.')
    const id = node?.id ?? `node-${crypto.randomUUID()}`
    const nextNode = node ? { ...node, name: agent.name, initialPrompt: prompt } : {
      id, agentId: agent.id, name: agent.name,
      position: { x: 80 + graph.nodes.length % 4 * 300, y: 100 + Math.floor(graph.nodes.length / 4) * 200 },
    }
    return changeDraftAgent(current, agent, { ...graph,
      nodes: node ? graph.nodes.map((item) => item.id === id ? nextNode : item) : [...graph.nodes, nextNode],
      entryNodeId: !graph.nodes.length ? id : graph.entryNodeId,
    })
  })
}

export function NewBoardAgent({ draftKey, edit, report }: { draftKey: string; edit: NextDraftEdit; report(error: unknown): void }) {
  const defaults = useAgentDefaultsQuery()
  return <section aria-label="Create board Agent"><h3>Create Agent</h3>
    {defaults.isError ? <p role="alert">Agent defaults are unavailable. <button type="button" onClick={() => void defaults.refetch()}>Retry defaults</button></p> : null}
    {(['orchestrator', 'coder'] as const).map((role) => <Button key={role} variant="secondary"
      disabled={!defaults.data || defaults.isError || edit.busy || !!edit.pending}
      onClick={() => {
        const saved = defaults.data?.value[role]
        if (!saved) return
        const name = role === 'orchestrator' ? 'Orchestrator' : `Worker ${edit.graph.nodes.length + 1}`
        try { installAgent(draftKey, edit.instanceId, defaultAgentForHarness(saved.harness.harness,
          `agent-${crypto.randomUUID()}`, name, saved.harness, role)) } catch (error) { report(error) }
      }}>{role === 'orchestrator' ? 'Orchestrator' : 'Worker'}</Button>)}
    <p>Uses saved defaults. New configurations are staged and validated by the same draft save service.</p>
  </section>
}

export function BoardAgentSettings({ draftKey, edit, nodeId, close }: { draftKey: string; edit: NextDraftEdit; nodeId: string; close(): void }) {
  const node = edit.graph.nodes.find((item) => item.id === nodeId)
  const agent = node && editorAgents(edit).find((item) => item.id === node.agentId)
  if (!node || !agent) return <p>Agent configuration is unavailable. No settings were inferred from a label.</p>
  return <AgentSettingsForm key={`${edit.instanceId}:${node.id}`} agent={agent} initialPrompt={node.initialPrompt}
    workspaceId={edit.graph.workspaceId} workflowApprovalHandler={edit.graph.approval?.handler}
    designatedOrchestrator={edit.graph.approval?.handler === 'orchestrator' && edit.graph.approval.designatedOrchestratorAgentId === agent.id}
    executionPolicy={edit.graph.executionPolicy} onClose={close}
    onSave={(next, prompt) => installAgent(draftKey, edit.instanceId, next, node.id, prompt)} />
}
