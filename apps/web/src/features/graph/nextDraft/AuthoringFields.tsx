import { useId, useState, type ReactNode } from 'react'
import type { WorkflowDefinitionV2, WorkflowRelationship } from '@graphql/contracts/wave25'
import { attachAgent, changeApprovalHandler, entryChoices, nodeTitle, putRelationship,
  removeNode, removeRelationship, roleEvidence, type DraftNode, type NextDraftContext } from './model'

export type EditGraph = (update: (graph: WorkflowDefinitionV2) => WorkflowDefinitionV2) => void
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="next-draft-field"><span>{label}</span>{children}</label>
}
export function NodeOptions({ graph }: { graph: WorkflowDefinitionV2 }) {
  return <>{graph.nodes.map((node) => <option key={node.id} value={node.id}>{nodeTitle(graph, node.id)} · {node.id}</option>)}</>
}

export function EntryFields({ graph, context, change }: { graph: WorkflowDefinitionV2; context: NextDraftContext; change: EditGraph }) {
  const choices = entryChoices(graph, context), id = useId()
  return <section aria-labelledby={id} className="next-draft-section">
    <h2 id={id}>Start here</h2>
    <Field label="Entry node"><select value={graph.entryNodeId ?? ''} aria-invalid={!choices.valid}
      onChange={(event) => change((value) => ({ ...value, entryNodeId: event.target.value || null }))}>
      <option value="">Select an entry</option>
      {graph.nodes.map((node) => <option key={node.id} value={node.id} disabled={!choices.eligible.some((item) => item.id === node.id)}>
        {nodeTitle(graph, node.id)} · {choices.roles.get(node.id)?.role === 'orchestrator' ? 'Orchestrator' : choices.roles.get(node.id)?.role === 'coder' ? 'Worker' : 'Role unavailable'}
      </option>)}
    </select></Field>
    <p>{choices.mode === 'sole' ? 'This node starts itself. Select it explicitly.' : choices.mode === 'orchestrator'
      ? 'Choose an Orchestrator. Its workflow node identity is pinned when saved.' : 'Choose a Worker. Moving or reordering nodes never changes entry.'}</p>
    {graph.entryNodeId && !graph.nodes.some((node) => node.id === graph.entryNodeId) ? <p role="alert">The selected entry no longer exists. Choose a replacement.</p> : null}
  </section>
}

export function ApprovalFields({ graph, context, change, report }: { graph: WorkflowDefinitionV2; context: NextDraftContext; change: EditGraph; report: (error: unknown) => void }) {
  return <section className="next-draft-section" aria-label="Approval handling">
    <h2>Approvals</h2>
    <Field label="Approval handler"><select value={graph.approval?.handler ?? ''} onChange={(event) => {
      const handler = event.target.value
      if (handler !== 'user' && handler !== 'orchestrator') return
      try { change((value) => changeApprovalHandler(value, handler)) } catch (error) { report(error) }
    }}><option value="" disabled>Choose a handler</option><option value="user">Human / Operator</option><option value="orchestrator">App reviewer</option></select></Field>
    {graph.approval?.handler === 'orchestrator' ? <Field label="Designated reviewer"><select value={graph.approval.designatedOrchestratorAgentId ?? ''}
      onChange={(event) => change((value) => ({ ...value, approval: { handler: 'orchestrator', ...(event.target.value ? { designatedOrchestratorAgentId: event.target.value } : {}) } }))}>
      <option value="">Choose the entry Orchestrator</option>
      {graph.nodes.filter((node) => roleEvidence(context, node.agentId).role === 'orchestrator').map((node) => <option key={node.id} value={node.agentId}>{nodeTitle(graph, node.id)} · {node.id}</option>)}
    </select></Field> : null}
    <p>Approval records point from reviewer to requester; they never schedule work.</p>
    <p>Executable save supports one initialized reviewer at the entry Orchestrator. Independent reviewers, nested review and dynamic delegation are not supported.</p>
  </section>
}

export function AttachAgentField({ graph, context, change, report }: { graph: WorkflowDefinitionV2; context: NextDraftContext; change: EditGraph; report: (error: unknown) => void }) {
  const [agentId, setAgentId] = useState('')
  const available = context.agents.filter((record) => !record.archivedAt && record.agent.configurationVersionId
    && record.agent.productRole && !graph.nodes.some((node) => node.agentId === record.agent.id))
  return <form className="next-draft-section" onSubmit={(event) => {
    event.preventDefault()
    const record = available.find((item) => item.agent.id === agentId)
    if (!record) return
    try { change((value) => attachAgent(value, record, `node-${crypto.randomUUID()}`)); setAgentId('') } catch (error) { report(error) }
  }}>
    <h2>Board Agents</h2>
    <Field label="Existing Agent"><select value={agentId} onChange={(event) => setAgentId(event.target.value)}>
      <option value="">Choose an Agent</option>{available.map(({ agent }) => <option key={agent.id} value={agent.id}>{agent.name} · {agent.productRole === 'orchestrator' ? 'Orchestrator' : 'Worker'}</option>)}
    </select></Field>
    <button type="submit" disabled={!available.some((item) => item.agent.id === agentId)}>Add to board</button>
    <p>Uses the selected Agent’s exact configuration and revision. Model settings are not changed.</p>
  </form>
}

function changeNode(change: EditGraph, nodeId: string, update: (node: DraftNode) => DraftNode) {
  change((graph) => ({ ...graph, nodes: graph.nodes.map((node) => node.id === nodeId ? update(node) : node) }))
}
export function NodeFields({ graph, node, context, change }: { graph: WorkflowDefinitionV2; node: DraftNode; context: NextDraftContext; change: EditGraph }) {
  const role = roleEvidence(context, node.agentId)
  const position = graph.nodes.findIndex((item) => item.id === node.id)
  const reorder = (offset: number) => change((value) => {
    const index = value.nodes.findIndex((item) => item.id === node.id), nodes = [...value.nodes]
    if (index < 0 || !nodes[index + offset]) return value
    ;[nodes[index], nodes[index + offset]] = [nodes[index + offset]!, nodes[index]!]
    return { ...value, nodes }
  })
  return <section className="next-draft-section" aria-label="Node settings">
    <h2>{graph.entryNodeId === node.id ? 'Entry · ' : ''}{nodeTitle(graph, node.id)}</h2>
    <code>{node.id}</code>
    <p>{role.role === 'orchestrator' ? 'Orchestrator' : role.role === 'coder' ? 'Worker' : 'Role unavailable'} · {role.source === 'staged' ? 'server-staged role; pinned on save' : role.configurationVersionId ?? 'configuration unavailable'}</p>
    <Field label="Node name"><input value={node.name ?? node.label ?? ''} onChange={(event) => changeNode(change, node.id, (item) => ({ ...item, name: event.target.value }))} /></Field>
    <Field label="Node instruction"><textarea rows={4} value={node.initialPrompt ?? ''} onChange={(event) => changeNode(change, node.id, (item) => {
      const next = { ...item }; if (event.target.value) next.initialPrompt = event.target.value; else delete next.initialPrompt; return next
    })} /></Field>
    <div className="next-draft-actions"><button type="button" disabled={position === 0} onClick={() => reorder(-1)}>Move earlier</button>
      <button type="button" disabled={position === graph.nodes.length - 1} onClick={() => reorder(1)}>Move later</button>
      <button type="button" onClick={() => change((value) => removeNode(value, node.id))}>Remove node</button></div>
    <p>Removing entry clears its selection. Outcome references to removed connections require explicit correction. Undo is available.</p>
    <ChoiceFields graph={graph} node={node} change={change} />
  </section>
}

export function ChoiceFields({ graph, node, change }: { graph: WorkflowDefinitionV2; node: DraftNode; change: EditGraph }) {
  const outgoing = graph.edges.filter((edge) => edge.kind === 'execution' && edge.source === node.id)
  const outcomes = node.choice?.outcomes ?? []
  const setOutcomes = (update: (items: typeof outcomes) => typeof outcomes) => changeNode(change, node.id, (value) => ({ ...value, choice: { outcomes: update(value.choice?.outcomes ?? []) } }))
  return <fieldset className="next-draft-choice"><legend>Successful result routing</legend>
    <Field label="Routing mode"><select value={node.choice ? 'choice' : 'fanout'} onChange={(event) => changeNode(change, node.id, (value) => {
      if (event.target.value === 'choice') return { ...value, choice: { outcomes: [] } }
      const next = { ...value }; delete next.choice; return next
    })}><option value="fanout">Ordinary fan-out</option><option value="choice">Declared outcome choice</option></select></Field>
    {!node.choice ? <p>A successful result selects all outgoing execution records.</p> : <>
      <p>Return one complete accepted successful result envelope. No prose, Markdown, expressions, node IDs or default route.</p>
      <pre>{'{"routing":{"outcome":"approved"},"data":{}}'}</pre>
      <p>Declare 1–16 unique outcomes. Every outcome chooses exactly one execution record or an explicit branch end.</p>
      {outcomes.map((item, index) => <div className="next-draft-outcome" key={index}>
        <Field label={`Outcome ${index + 1}`}><input value={item.outcome} maxLength={48} pattern="[a-z][a-z0-9_]{0,47}"
          onChange={(event) => setOutcomes((items) => items.map((value, i) => i === index ? { ...value, outcome: event.target.value } : value))} /></Field>
        <Field label={`Target for outcome ${index + 1}`}><select value={item.target.kind === 'branch_end' ? 'end' : `edge:${item.target.relationshipId}`}
          onChange={(event) => setOutcomes((items) => items.map((value, i) => i !== index ? value : { ...value, target: event.target.value === 'end'
            ? { kind: 'branch_end' } : { kind: 'edge', relationshipId: event.target.value.slice(5) } }))}>
          <option value="edge:">Choose a target</option>
          {item.target.kind === 'edge' && item.target.relationshipId && !outgoing.some((edge) => item.target.kind === 'edge' && edge.id === item.target.relationshipId) ? <option value={`edge:${item.target.relationshipId}`}>Missing execution record · {item.target.relationshipId}</option> : null}
          {outgoing.map((edge) => <option key={edge.id} value={`edge:${edge.id}`}>{nodeTitle(graph, edge.target)} · {edge.id}</option>)}
          <option value="end">End this branch</option>
        </select></Field>
        <button type="button" aria-label={`Remove outcome ${index + 1}`} onClick={() => setOutcomes((items) => items.filter((_, i) => i !== index))}>Remove outcome</button>
      </div>)}
      <button type="button" disabled={outcomes.length >= 16} onClick={() => setOutcomes((items) => [...items, { outcome: '', target: { kind: 'edge', relationshipId: '' } }])}>Add outcome</button>
    </>}
  </fieldset>
}

export function RelationshipFields({ graph, relationship, change, report }: { graph: WorkflowDefinitionV2; relationship: WorkflowRelationship; change: EditGraph; report: (error: unknown) => void }) {
  const put = (update: Partial<WorkflowRelationship>) => {
    try { change((value) => putRelationship(value, { ...relationship, ...update })) } catch (error) { report(error) }
  }
  const approval = relationship.kind === 'approval'
  return <section className="next-draft-section" aria-label="Relationship settings">
    <h2>{approval ? 'Approval assignment' : 'Execution dependency'}</h2><code>{relationship.id}</code>
    <Field label={approval ? 'Reviewer' : 'Sender'}><select value={relationship.source} onChange={(event) => put({ source: event.target.value })}><NodeOptions graph={graph} /></select></Field>
    <Field label={approval ? 'Requester' : 'Receiver'}><select value={relationship.target} onChange={(event) => put({ target: event.target.value })}><NodeOptions graph={graph} /></select></Field>
    <Field label="Connection label"><input value={relationship.label ?? ''} onChange={(event) => put({ label: event.target.value })} /></Field>
    <p>Direction: {nodeTitle(graph, relationship.source)} → {nodeTitle(graph, relationship.target)}. The kind and ID cannot be repurposed.</p>
    <button type="button" onClick={() => change((value) => removeRelationship(value, relationship.id))}>Remove this {relationship.kind} record</button>
  </section>
}

export function ConnectionFields({ graph, kind, setKind, change, report }: { graph: WorkflowDefinitionV2; kind: WorkflowRelationship['kind']; setKind: (kind: WorkflowRelationship['kind']) => void; change: EditGraph; report: (error: unknown) => void }) {
  const [source, setSource] = useState(''), [target, setTarget] = useState('')
  return <form className="next-draft-section" onSubmit={(event) => {
    event.preventDefault()
    try { change((value) => putRelationship(value, { id: `relationship-${crypto.randomUUID()}`, kind, source, target })); setTarget('') } catch (error) { report(error) }
  }}>
    <h2>Add a connection</h2>
    <Field label="Connection meaning"><select value={kind} onChange={(event) => setKind(event.target.value === 'approval' ? 'approval' : 'execution')}>
      <option value="execution">Execution dependency</option><option value="approval">Approval assignment</option></select></Field>
    <p>{kind === 'approval' ? 'Reviewer → requester. Does not create a work route.' : 'Sender → receiver. Only execution records schedule work.'}</p>
    <Field label={kind === 'approval' ? 'New reviewer' : 'New sender'}><select value={source} onChange={(event) => setSource(event.target.value)}><option value="">Choose a node</option><NodeOptions graph={graph} /></select></Field>
    <Field label={kind === 'approval' ? 'New requester' : 'New receiver'}><select value={target} onChange={(event) => setTarget(event.target.value)}><option value="">Choose a node</option><NodeOptions graph={graph} /></select></Field>
    <button type="submit" disabled={!source || !target || source === target || !graph.nodes.some((node) => node.id === source) || !graph.nodes.some((node) => node.id === target)}>Add {kind} record</button>
  </form>
}
