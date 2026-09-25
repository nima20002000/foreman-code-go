import { useMemo } from 'react'
import type { WorkflowDefinitionV2 } from '@graphql/contracts/wave25'
import { Alert, Badge, Button, Checkbox, Select, TextField } from '../../shared/ui/nocturne'
import { repeatClient, type RepeatClient } from './client'
import { blockOutcomeOptions, repeatPlanFromLocalDraft, targetLabel, type RepeatLocalBlockDraft } from './repeatModel'
import { useRepeatAuthoring, type RepeatRuntimeGuard } from './useRepeatAuthoring'
import './repeats.css'

const copyBlock = (block: RepeatLocalBlockDraft): RepeatLocalBlockDraft => ({ ...block, nodeIds: [...block.nodeIds] })

type SourcePin = { agentId: string; configurationVersionId: string }

export function RepeatEditor({ workspaceId, workflowId, graph, activeRuns, sourceAgentPins, disabled = false,
  client = repeatClient, onRuntimeGuardChange }: {
  workspaceId: string
  workflowId: string
  graph: WorkflowDefinitionV2
  activeRuns: number
  sourceAgentPins?: SourcePin[]
  disabled?: boolean
  client?: RepeatClient
  onRuntimeGuardChange?(guard: RepeatRuntimeGuard): void
}) {
  const repeat = useRepeatAuthoring({ workspaceId, workflowId, graph, activeRuns, sourceAgentPins, client, onRuntimeGuardChange })
  const nodeOptions = useMemo(() => graph.nodes.map((node) => ({ value: node.id, label: node.name ?? node.label ?? node.id })), [graph.nodes])
  const updateBlock = (index: number, update: (block: RepeatLocalBlockDraft) => RepeatLocalBlockDraft) => repeat.change((draft) => ({ ...draft,
    blocks: draft.blocks.map((block, item) => item === index ? update(copyBlock(block)) : block),
  }))
  const removeBlock = (index: number) => repeat.change((draft) => ({ ...draft, blocks: draft.blocks.filter((_, item) => item !== index) }))
  const addBlock = () => repeat.change((draft) => ({ ...draft, blocks: [...draft.blocks, {
    id: `repeat-${draft.blocks.length + 1}`, nodeIds: [], entryNodeId: '', exitNodeId: '', maxOccurrences: 2,
    repeatOutcome: '', earlyExitOutcome: '',
  }] }))

  if (repeat.query.isPending && !repeat.query.data) return <section className="repeat-editor" role="status">Loading repeat settings…</section>
  if (repeat.query.isError && !repeat.query.data) return <section className="repeat-editor" role="alert">
    <Alert tone="danger" title="Repeat settings are unavailable.">Your workflow has not been changed. Saved state was not guessed from the board.</Alert>
    <Button size="sm" onClick={() => void repeat.query.refetch()}>Retry</Button>
  </section>

  const meaningfulUnavailable = activeRuns > 0 && !repeat.guard.meaningfulEdit
  return <section className="repeat-editor" aria-label="Repeat settings">
    <div className="repeat-heading"><div><h3>Business repeats</h3><p>Repeat a flat section of this workflow a finite number of times.</p></div>
      <Badge tone={repeat.dirty ? 'warning' : 'neutral'} dot>{repeat.dirty ? 'Unsaved' : 'Saved'}</Badge></div>
    <Alert tone="neutral" title="Finite repeats only">Scopes cannot overlap or nest. The workflow stays acyclic: this does not add a back-edge. A technical retry stays inside the same business occurrence.</Alert>
    {repeat.guard.hasSavedRepeat && !repeat.guard.runtimeAdmission ? <Alert tone="warning" title="Starting this repeat is not available yet.">
      The deployment reports runtime admission unavailable{repeat.guard.reason ? ` (${repeat.guard.reason})` : ''}. The board must not pretend a repeat Run can start.</Alert> : null}
    {meaningfulUnavailable ? <Alert tone="warning" title="Stop-and-save is not available yet.">
      The deployment has not enabled meaningful repeat edits. Your local form stays here; Discard does not Stop any Run.</Alert> : null}
    {repeat.stale ? <Alert tone="warning" live title="The saved workflow changed elsewhere."
      action={<Button size="sm" onClick={() => void repeat.reload().catch(() => undefined)}>Reload saved repeat</Button>}>Your local changes are retained and will not overwrite the newer revision.</Alert> : null}
    {repeat.uncertain ? <Alert tone="warning" live title="The last repeat command may have gone through."
      action={<Button size="sm" onClick={() => void repeat.reconcile().catch(() => undefined)}>Check exact command</Button>}>The same draft and command IDs are retained. No replacement command is sent.</Alert> : null}
    {repeat.error && !repeat.uncertain ? <Alert tone="danger" live title="Repeat settings were not saved.">{repeat.error}</Alert> : null}

    <div className="repeat-blocks">
      {repeat.value.blocks.map((block, index) => {
        const outcomes = blockOutcomeOptions(graph, block.exitNodeId)
        const repeatTarget = repeatPlanFromLocalDraft({ contractVersion: repeat.value.contractVersion, blocks: [block] }, graph)?.blocks[0]?.limitExit
        const blockIssues = repeat.issues.filter((issue) => !issue.blockId || issue.blockId === block.id)
        return <fieldset className="repeat-block" key={`${index}:${block.id}`} disabled={disabled || repeat.busy || repeat.uncertain || repeat.retained}>
          <legend>Repeat {index + 1}</legend>
          <TextField label="Repeat name" value={block.id} required onChange={(event) => updateBlock(index, (value) => ({ ...value, id: event.currentTarget.value }))}
            hint="Stable ID used by durable occurrence records." />
          <div className="repeat-scope"><span className="repeat-label">Scope</span><p>Choose the nodes that form one entry-to-exit section.</p>
            <div className="repeat-node-grid">{nodeOptions.map((option) => <Checkbox key={option.value} label={option.label}
              checked={block.nodeIds.includes(option.value)} onChange={(event) => updateBlock(index, (value) => ({ ...value,
                nodeIds: event.currentTarget.checked ? [...value.nodeIds, option.value] : value.nodeIds.filter((id) => id !== option.value),
              }))} />)}</div></div>
          <div className="repeat-grid">
            <Select label="Entry node" value={block.entryNodeId} required options={[{ value: '', label: 'Choose entry' }, ...nodeOptions]}
              onChange={(event) => updateBlock(index, (value) => ({ ...value, entryNodeId: event.currentTarget.value }))} />
            <Select label="Exit node" value={block.exitNodeId} required options={[{ value: '', label: 'Choose exit' }, ...nodeOptions]}
              onChange={(event) => updateBlock(index, (value) => ({ ...value, exitNodeId: event.currentTarget.value, repeatOutcome: '', earlyExitOutcome: '' }))} />
            <TextField label="Maximum occurrences" type="number" min={1} max={2147483647} step={1} required value={block.maxOccurrences}
              hint="Counts the first business occurrence. 1 means no repetition after it."
              onChange={(event) => updateBlock(index, (value) => ({ ...value, maxOccurrences: Number(event.currentTarget.value) }))} />
            <Select label="Repeat outcome" value={block.repeatOutcome} required options={[{ value: '', label: 'Choose outcome' }, ...outcomes.map((outcome) => ({ value: outcome, label: outcome }))]}
              onChange={(event) => updateBlock(index, (value) => ({ ...value, repeatOutcome: event.currentTarget.value }))} />
            <Select label="Early-exit outcome" value={block.earlyExitOutcome} required options={[{ value: '', label: 'Choose outcome' }, ...outcomes.map((outcome) => ({ value: outcome, label: outcome }))]}
              onChange={(event) => updateBlock(index, (value) => ({ ...value, earlyExitOutcome: event.currentTarget.value }))} />
          </div>
          <div className="repeat-limit-route"><strong>At the cap</strong><span>{targetLabel(repeatTarget)}</span><small>The limit route is the saved target of the repeat outcome. It is not a hidden success, failure, approval, or extra occurrence.</small></div>
          {blockIssues.length ? <ul className="repeat-errors" aria-label={`Problems in repeat ${index + 1}`}>{blockIssues.map((issue) => <li key={`${issue.code}:${issue.message}`}>{issue.message}</li>)}</ul> : null}
          <Button size="sm" variant="ghost" disabled={repeat.value.blocks.length === 1} title={repeat.value.blocks.length === 1 ? 'The current shared contract does not support publishing an empty repeat plan.' : undefined}
            onClick={() => removeBlock(index)}>Remove repeat</Button>
        </fieldset>
      })}
    </div>
    <Button size="sm" variant="secondary" onClick={addBlock} disabled={disabled || repeat.busy || repeat.uncertain || repeat.retained}>Add repeat</Button>
    {!repeat.value.blocks.length ? <p className="repeat-muted">Add at least one repeat block to publish semantics 3. The current shared contract does not define an empty repeat plan.</p> : null}
    {repeat.issues.filter((issue) => !issue.blockId).length ? <ul className="repeat-errors" aria-label="Repeat plan problems">
      {repeat.issues.filter((issue) => !issue.blockId).map((issue) => <li key={`${issue.code}:${issue.message}`}>{issue.message}</li>)}</ul> : null}
    {repeat.dirty ? <div className="repeat-save-bar" role="region" aria-label="Unsaved repeat changes">
      <span>Repeat changes are meaningful execution edits and apply only to a new immutable saved version.</span>
      <Button size="sm" variant="ghost" disabled={repeat.busy || repeat.uncertain} onClick={() => void repeat.discard().catch(() => undefined)}>Discard changes</Button>
      {activeRuns > 0 ? <Button size="sm" variant="primary" loading={repeat.busy} disabled={!repeat.canStopAndSave}
        title={meaningfulUnavailable ? 'Meaningful repeat edit capability is unavailable.' : undefined}
        onClick={() => void repeat.stopAndSave().catch(() => undefined)}>Stop current Run and save edits</Button>
        : <Button size="sm" variant="primary" loading={repeat.busy} disabled={!repeat.canDirectSave}
          onClick={() => void repeat.save().catch(() => undefined)}>Save repeat</Button>}
    </div> : null}
  </section>
}
