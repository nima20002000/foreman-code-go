import { useId, useState } from 'react'
import type { WorkflowDefinitionV2, WorkflowRelationship } from '@graphql/contracts/wave25'
import type { DraftAgentEdits } from './agentEdits'
import { attachAgent, changeApprovalHandler, entryChoices, nodeTitle, putRelationship,
  removeRelationship, roleEvidence, type DraftNode, type NextDraftContext } from './model'
import { Button, Icon, IconButton, SegmentedControl, Select, Switch, TextField, type SelectOption } from '../../../shared/ui/nocturne'

export type EditGraph = (update: (graph: WorkflowDefinitionV2) => WorkflowDefinitionV2) => void
function nodeOptions(graph: WorkflowDefinitionV2, except?: string): SelectOption[] {
  return graph.nodes.filter((node) => node.id !== except).map((node) => ({ value: node.id, label: nodeTitle(graph, node.id) }))
}
function changeNode(change: EditGraph, nodeId: string, update: (node: DraftNode) => DraftNode) {
  change((graph) => ({ ...graph, nodes: graph.nodes.map((node) => node.id === nodeId ? update(node) : node) }))
}

export function EntryFields({ graph, context, change, agentEdits }: { graph: WorkflowDefinitionV2; context: NextDraftContext; change: EditGraph; agentEdits?: DraftAgentEdits }) {
  const choices = entryChoices(graph, context, agentEdits), id = useId()
  return <section aria-labelledby={id} className="next-draft-section">
    <h3 id={id}>Starting agent</h3>
    <Select label="Starts the workflow" value={graph.entryNodeId ?? ''} aria-invalid={!choices.valid}
      onChange={(event) => change((value) => ({ ...value, entryNodeId: event.target.value || null }))} options={[
        { value: '', label: 'Choose an agent' },
        ...graph.nodes.map((node) => ({ value: node.id, disabled: !choices.eligible.some((item) => item.id === node.id), label: nodeTitle(graph, node.id) })),
      ]} />
    <p className="next-draft-hint">{choices.mode === 'orchestrator' ? 'Only an orchestrator can start a workflow that has one.' : 'The first agent to run. It can’t receive a handoff.'}</p>
    {graph.entryNodeId && !graph.nodes.some((node) => node.id === graph.entryNodeId) ? <p role="alert">The starting agent was removed. Choose another one.</p> : null}
  </section>
}

export function ApprovalFields({ graph, context, change, report, agentEdits }: { graph: WorkflowDefinitionV2; context: NextDraftContext; change: EditGraph; report: (error: unknown) => void; agentEdits?: DraftAgentEdits }) {
  return <section className="next-draft-section" aria-label="Approval handling">
    <h3>Approvals</h3>
    <Select label="Approval handler" value={graph.approval?.handler ?? ''} onChange={(event) => {
      const handler = event.target.value
      if (handler !== 'user' && handler !== 'orchestrator') return
      try { change((value) => changeApprovalHandler(value, handler)) } catch (error) { report(error) }
    }} options={[{ value: '', label: 'Choose who approves', disabled: true }, { value: 'user', label: 'You, the Operator' }, { value: 'orchestrator', label: 'An orchestrator agent' }]} />
    {graph.approval?.handler === 'orchestrator' ? <Select label="Reviewing orchestrator" value={graph.approval.designatedOrchestratorAgentId ?? ''}
      onChange={(event) => change((value) => ({ ...value, approval: { handler: 'orchestrator', ...(event.target.value ? { designatedOrchestratorAgentId: event.target.value } : {}) } }))} options={[
        { value: '', label: 'Choose an orchestrator' },
        ...graph.nodes.filter((node) => roleEvidence(context, node.agentId, agentEdits).role === 'orchestrator').map((node) => ({ value: node.agentId, label: nodeTitle(graph, node.id) })),
      ]} /> : null}
    <p className="next-draft-hint">{graph.approval?.handler === 'orchestrator'
      ? 'The starting orchestrator reviews requests from agents it has an approval connection to.' : 'Agents ask you before sensitive actions. Requests appear in the approval inbox.'}</p>
  </section>
}

export function AttachAgentField({ graph, context, change, report }: { graph: WorkflowDefinitionV2; context: NextDraftContext; change: EditGraph; report: (error: unknown) => void }) {
  const [agentId, setAgentId] = useState('')
  const available = context.agents.filter((record) => !record.archivedAt && record.agent.configurationVersionId
    && record.agent.productRole && !graph.nodes.some((node) => node.agentId === record.agent.id))
  if (!available.length) return null
  return <form className="next-draft-section" onSubmit={(event) => {
    event.preventDefault()
    const record = available.find((item) => item.agent.id === agentId)
    if (!record) return
    try { change((value) => attachAgent(value, record, `node-${crypto.randomUUID()}`)); setAgentId('') } catch (error) { report(error) }
  }}>
    <h3>Existing agent</h3>
    <div className="next-draft-inline">
      <Select label="Existing agent" value={agentId} onChange={(event) => setAgentId(event.target.value)} options={[
        { value: '', label: 'Choose an agent' },
        ...available.map(({ agent }) => ({ value: agent.id, label: `${agent.name} · ${agent.productRole === 'orchestrator' ? 'Orchestrator' : 'Worker'}` })),
      ]} />
      <Button type="submit" disabled={!available.some((item) => item.agent.id === agentId)}>Add to workflow</Button>
    </div>
    <p className="next-draft-hint">Keeps that agent’s saved settings.</p>
  </form>
}

/** The node's place in this workflow: whether it starts it and where its result goes. */
export function NodeWorkflowFields({ graph, node, context, change, agentEdits }: { graph: WorkflowDefinitionV2; node: DraftNode; context: NextDraftContext; change: EditGraph; agentEdits?: DraftAgentEdits }) {
  const choices = entryChoices(graph, context, agentEdits)
  const eligible = choices.eligible.some((item) => item.id === node.id)
  const starts = graph.entryNodeId === node.id
  return <section className="next-draft-section" aria-label="In this workflow">
    <h3>In this workflow</h3>
    <Switch label="Starts the workflow" checked={starts} disabled={!eligible && !starts}
      hint={!eligible && !starts ? choices.mode === 'orchestrator' ? 'Only an orchestrator can start this workflow.' : 'This agent can’t start the workflow.' : undefined}
      onChange={(event) => { const checked = event.currentTarget.checked; change((value) => ({ ...value, entryNodeId: checked ? node.id : value.entryNodeId === node.id ? null : value.entryNodeId })) }} />
    <ChoiceFields graph={graph} node={node} change={change} />
  </section>
}

export function ChoiceFields({ graph, node, change }: { graph: WorkflowDefinitionV2; node: DraftNode; change: EditGraph }) {
  const outgoing = graph.edges.filter((edge) => edge.kind === 'execution' && edge.source === node.id)
  const outcomes = node.choice?.outcomes ?? []
  const setOutcomes = (update: (items: typeof outcomes) => typeof outcomes) => changeNode(change, node.id, (value) => ({ ...value, choice: { outcomes: update(value.choice?.outcomes ?? []) } }))
  return <fieldset className="next-draft-choice"><legend>When this agent finishes</legend>
    <Select label="Routing mode" value={node.choice ? 'choice' : 'fanout'} onChange={(event) => changeNode(change, node.id, (value) => {
      if (event.target.value === 'choice') return { ...value, choice: { outcomes: [] } }
      const next = { ...value }; delete next.choice; return next
    })} options={[{ value: 'fanout', label: 'Hand off to every connected agent' }, { value: 'choice', label: 'Choose one handoff by outcome' }]} />
    {node.choice ? <>
      <p className="next-draft-hint">The agent ends with an outcome name, and only the matching handoff runs.</p>
      <details className="next-draft-details"><summary>Result format</summary>
        <p>Return exactly this JSON, with no other text:</p>
        <pre>{'{"routing":{"outcome":"approved"},"data":{}}'}</pre>
      </details>
      {outcomes.map((item, index) => <div className="next-draft-outcome" key={index}>
        <TextField label={`Outcome ${index + 1}`} value={item.outcome} maxLength={48} pattern="[a-z][a-z0-9_]{0,47}" placeholder="approved"
          onChange={(event) => setOutcomes((items) => items.map((value, i) => i === index ? { ...value, outcome: event.target.value } : value))} />
        <Select label={`Target for outcome ${index + 1}`} value={item.target.kind === 'branch_end' ? 'end' : `edge:${item.target.relationshipId}`}
          onChange={(event) => setOutcomes((items) => items.map((value, i) => i !== index ? value : { ...value, target: event.target.value === 'end'
            ? { kind: 'branch_end' } : { kind: 'edge', relationshipId: event.target.value.slice(5) } }))} options={[
            { value: 'edge:', label: 'Choose where it goes' },
            ...(item.target.kind === 'edge' && item.target.relationshipId && !outgoing.some((edge) => item.target.kind === 'edge' && edge.id === item.target.relationshipId)
              ? [{ value: `edge:${item.target.relationshipId}`, label: 'Removed handoff' }] : []),
            ...outgoing.map((edge) => ({ value: `edge:${edge.id}`, label: `Hand off to ${nodeTitle(graph, edge.target)}` })),
            { value: 'end', label: 'End here' },
          ]} />
        <IconButton size="sm" variant="ghost" label={`Remove outcome ${index + 1}`} onClick={() => setOutcomes((items) => items.filter((_, i) => i !== index))}><Icon name="close" size={14} /></IconButton>
      </div>)}
      <Button size="sm" leading={<Icon name="plus" size={14} />} disabled={outcomes.length >= 16} onClick={() => setOutcomes((items) => [...items, { outcome: '', target: { kind: 'edge', relationshipId: '' } }])}>Add outcome</Button>
    </> : null}
  </fieldset>
}

export function RelationshipFields({ graph, relationship, change, report }: { graph: WorkflowDefinitionV2; relationship: WorkflowRelationship; change: EditGraph; report: (error: unknown) => void }) {
  const put = (update: Partial<WorkflowRelationship>) => {
    try { change((value) => putRelationship(value, { ...relationship, ...update })) } catch (error) { report(error) }
  }
  const approval = relationship.kind === 'approval'
  return <section className="next-draft-section" aria-label="Connection settings">
    <p className="next-draft-hint">{approval ? 'The reviewer answers approval requests from the other agent. It doesn’t pass work.' : 'When the first agent finishes, its result goes to the second one.'}</p>
    <Select label={approval ? 'Reviewer' : 'From'} value={relationship.source} onChange={(event) => put({ source: event.target.value })} options={nodeOptions(graph)} />
    <Select label={approval ? 'Asks for approval' : 'To'} value={relationship.target} onChange={(event) => put({ target: event.target.value })} options={nodeOptions(graph)} />
    <TextField label="Label" hint="Optional. Shown on the connection." value={relationship.label ?? ''} onChange={(event) => put({ label: event.target.value })} />
    <Button variant="danger" size="sm" onClick={() => change((value) => removeRelationship(value, relationship.id))}>Remove connection</Button>
  </section>
}

/** Connections to and from one agent, with a keyboard way to add one (dragging from the rim port also works). */
export function NodeConnections({ graph, nodeId, change, report }: { graph: WorkflowDefinitionV2; nodeId: string; change: EditGraph; report: (error: unknown) => void }) {
  const [target, setTarget] = useState(''), [kind, setKind] = useState<WorkflowRelationship['kind']>('execution')
  const related = graph.edges.filter((edge) => edge.source === nodeId || edge.target === nodeId)
  return <section className="next-draft-section" aria-label="Connections">
    <h3>Connections</h3>
    {related.length ? <ul className="next-draft-connections">{related.map((edge) => {
      const outgoing = edge.source === nodeId, other = nodeTitle(graph, outgoing ? edge.target : edge.source)
      const text = edge.kind === 'approval' ? outgoing ? `Reviews ${other}` : `Asks ${other} for approval` : outgoing ? `Hands off to ${other}` : `Receives from ${other}`
      return <li key={edge.id} data-direction={outgoing ? 'out' : 'in'}><Icon name="arrow" size={14} /><span>{text}{edge.label ? ` · ${edge.label}` : ''}</span>
        <IconButton size="sm" variant="ghost" label={`Remove connection: ${text}`} onClick={() => change((value) => removeRelationship(value, edge.id))}><Icon name="close" size={14} /></IconButton></li>
    })}</ul> : <p className="next-draft-hint">No connections yet. Drag from the dot on the agent’s right edge to another agent.</p>}
    {graph.nodes.length > 1 ? <form className="next-draft-connect" onSubmit={(event) => {
      event.preventDefault()
      if (!target) return
      try {
        change((value) => value.edges.some((edge) => edge.kind === kind && edge.source === nodeId && edge.target === target) ? value
          : putRelationship(value, { id: `relationship-${crypto.randomUUID()}`, kind, source: nodeId, target })); setTarget('')
      } catch (error) { report(error) }
    }}>
      <SegmentedControl label="Connection type" value={kind} onValueChange={(value) => setKind(value === 'approval' ? 'approval' : 'execution')}
        options={[{ value: 'execution', label: 'Handoff' }, { value: 'approval', label: 'Approval' }]} />
      <div className="next-draft-inline">
        <Select label={kind === 'approval' ? 'Reviews' : 'Hand off to'} value={target} onChange={(event) => setTarget(event.target.value)}
          options={[{ value: '', label: 'Choose an agent' }, ...nodeOptions(graph, nodeId)]} />
        <Button type="submit" disabled={!target}>Connect</Button>
      </div>
    </form> : null}
  </section>
}


