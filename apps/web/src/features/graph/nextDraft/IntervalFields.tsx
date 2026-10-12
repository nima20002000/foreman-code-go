import { useState } from 'react'
import { AGENT_INTERVAL_MAX_SECONDS, AGENT_INTERVAL_MIN_SECONDS, type WorkflowDefinitionV3 } from '@foreman-code/contracts/wave25'
import { Select, Switch, TextField } from '../../../shared/ui/nocturne'
import type { DraftNode } from './model'
import { largestUnit, unitSeconds, UNITS, type Unit } from './intervalLabel'

/** Off by default. While its Run is active, the Agent is re-activated in its own session to check on the Run. */
export function IntervalFields({ node, change }: {
  node: DraftNode; change: (update: (graph: WorkflowDefinitionV3) => WorkflowDefinitionV3) => void
}) {
  const everySeconds = node.kind === 'job' ? undefined : node.interval?.everySeconds
  const [unit, setUnit] = useState<Unit>(() => everySeconds ? largestUnit(everySeconds) : 'minutes')
  const [count, setCount] = useState(() => everySeconds ? String(everySeconds / unitSeconds(largestUnit(everySeconds))) : '1')
  if (node.kind === 'job') return null
  const write = (seconds: number | undefined) => change((graph) => ({ ...graph, nodes: graph.nodes.map((item) => {
    if (item.id !== node.id || item.kind === 'job') return item
    const next = { ...item }
    if (seconds === undefined) delete next.interval
    else next.interval = { everySeconds: seconds }
    return next
  }) }))
  const seconds = Number(count) * unitSeconds(unit)
  const valid = Number.isInteger(seconds) && seconds >= AGENT_INTERVAL_MIN_SECONDS && seconds <= AGENT_INTERVAL_MAX_SECONDS
  const apply = (nextCount: string, nextUnit: Unit) => {
    setCount(nextCount); setUnit(nextUnit)
    const value = Number(nextCount) * unitSeconds(nextUnit)
    if (Number.isInteger(value) && value >= AGENT_INTERVAL_MIN_SECONDS && value <= AGENT_INTERVAL_MAX_SECONDS) write(value)
  }
  return <fieldset className="next-draft-choice"><legend>Interval checks</legend>
    <Switch label="Re-activate on an interval" checked={everySeconds !== undefined}
      hint="While the Run is active, this agent is woken to check the Run's status and, in its own session, its earlier work. Checks never hand off work. Needs native approval handling or a Codex agent that never asks for approval, and no artifact outputs."
      onChange={(event) => write(event.currentTarget.checked ? (valid ? seconds : 60) : undefined)} />
    {everySeconds !== undefined ? <div className="next-draft-inline">
      <TextField label="Every" type="number" inputMode="numeric" min={1} step={1} value={count}
        error={valid ? undefined : 'Choose between 10 seconds and 24 hours.'}
        onChange={(event) => apply(event.target.value, unit)} />
      <Select label="Unit" value={unit} options={UNITS.map(({ value, label }) => ({ value, label }))}
        onChange={(event) => apply(count, event.target.value as Unit)} />
    </div> : null}
  </fieldset>
}
