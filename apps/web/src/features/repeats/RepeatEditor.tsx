import { useMemo } from 'react'
import type { WorkflowDefinitionV2 } from '@graphql/contracts/wave25'
import { Alert, Badge, Button, Checkbox, Select, TextField } from '../../shared/ui/nocturne'
import { repeatClient, type RepeatClient } from './client'
import { blockOutcomeOptions, repeatPlanFromLocalDraft, targetLabel, type RepeatLocalBlockDraft } from './repeatModel'
import { useRepeatAuthoring } from './useRepeatAuthoring'
import './repeats.css'

const copyBlock = (block: RepeatLocalBlockDraft): RepeatLocalBlockDraft => ({ ...block, nodeIds: [...block.nodeIds] })

export function RepeatEditor({ workspaceId, workflowId, graph, activeRuns, disabled = false, client = repeatClient }: {
  workspaceId: string
  workflowId: string
  graph: WorkflowDefinitionV2
  activeRuns: number
  disabled?: boolean
  client?: RepeatClient
}) {
  const repeat = useRepeatAuthoring({ workspaceId, workflowId, graph, activeRuns, client })
  const nodeOptions = useMemo(() => graph.nodes.map((node) => ({ value: node.id, label: node.id })), [graph.nodes])
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
    <Alert tone="danger" title="Repeat settings are unavailable.">Your workflow has not been changed.</Alert>
    <Button size="sm" onClick={() => void repeat.query.refetch()}>Retry</Button>
  </section>

  return <section className="repeat-editor" aria-label="Repeat settings">
    <div className="repeat-heading"><div><h3>Business repeats</h3><p>Repeat a flat section of this workflow a finite number of times.</p></div>
      <Badge tone={repeat.dirty ? 'warning' : 'neutral'} dot>{repeat.dirty ? 'Unsaved' : 'Saved'}</Badge></div>
    <Alert tone="neutral" title="Finite repeats only">Scopes cannot overlap or nest. The workflow stays acyclic: this does not add a back-edge. Technical retries stay inside the same business occurrence.</Alert>
    {repeat.stale ? <Alert tone="warning" live title="The saved repeat changed elsewhere."
      action={<Button size="sm" onClick={repeat.reload}>Reload saved repeat</Button>}>Your local changes are retained and will not overwrite the newer revision.</Alert> : null}
    {repeat.uncertain ? <Alert tone="warning" live title="We could not confirm whether the save finished.">Keep this draft open and reconcile the saved repeat before retrying or discarding.</Alert> : null}
    {repeat.error && !repeat.uncertain ? <Alert tone="danger" live title="Repeat settings were not saved.">{repeat.error}</Alert> : null}

    <div className="repeat-blocks">
      {repeat.value.blocks.map((block, index) => {
        const outcomes = blockOutcomeOptions(graph, block.exitNodeId)
        const repeatTarget = repeatPlanFromLocalDraft({ contractVersion: repeat.value.contractVersion, blocks: [block] }, graph)?.blocks[0]?.limitExit
        const blockIssues = repeat.issues.filter((issue) => !issue.blockId || issue.blockId === block.id)
        return <fieldset className="repeat-block" key={`${index}:${block.id}`} disabled={disabled || repeat.busy || repeat.uncertain}>
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
              hint="Counts the first occurrence. 1 means no business repeat."
              onChange={(event) => updateBlock(index, (value) => ({ ...value, maxOccurrences: Number(event.currentTarget.value) }))} />
            <Select label="Repeat outcome" value={block.repeatOutcome} required options={[{ value: '', label: 'Choose outcome' }, ...outcomes.map((outcome) => ({ value: outcome, label: outcome }))]}
              onChange={(event) => updateBlock(index, (value) => ({ ...value, repeatOutcome: event.currentTarget.value }))} />
            <Select label="Early-exit outcome" value={block.earlyExitOutcome} required options={[{ value: '', label: 'Choose outcome' }, ...outcomes.map((outcome) => ({ value: outcome, label: outcome }))]}
              onChange={(event) => updateBlock(index, (value) => ({ ...value, earlyExitOutcome: event.currentTarget.value }))} />
          </div>
          <div className="repeat-limit-route"><strong>At the cap</strong><span>{targetLabel(repeatTarget)}</span><small>The limit route is the saved target of the repeat outcome; it is not a hidden success or failure.</small></div>
          {blockIssues.length ? <ul className="repeat-errors" aria-label={`Problems in repeat ${index + 1}`}>{blockIssues.map((issue) => <li key={issue.code}>{issue.message}</li>)}</ul> : null}
          <Button size="sm" variant="ghost" onClick={() => removeBlock(index)}>Remove repeat</Button>
        </fieldset>
      })}
    </div>
    <Button size="sm" variant="secondary" onClick={addBlock} disabled={disabled || repeat.busy || repeat.uncertain}>Add repeat</Button>
    {repeat.issues.filter((issue) => !issue.blockId).length ? <ul className="repeat-errors" aria-label="Repeat plan problems">
      {repeat.issues.filter((issue) => !issue.blockId).map((issue) => <li key={issue.code}>{issue.message}</li>)}</ul> : null}
    {repeat.dirty ? <div className="repeat-save-bar" role="region" aria-label="Unsaved repeat changes">
      <span>Repeat changes affect execution and apply only to a new saved version.</span>
      <Button size="sm" variant="ghost" disabled={repeat.busy || repeat.uncertain} onClick={() => void repeat.discard()}>Discard changes</Button>
      <Button size="sm" variant="primary" loading={repeat.busy} disabled={!repeat.canSubmit}
        onClick={() => void (activeRuns > 0 ? repeat.stopAndSave() : repeat.save())}>
        {activeRuns > 0 ? 'Stop current Run and save edits' : 'Save repeat'}
      </Button>
    </div> : null}
  </section>
}
