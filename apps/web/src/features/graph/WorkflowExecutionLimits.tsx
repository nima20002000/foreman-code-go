import { useId, useRef, useState } from 'react'
import type { WorkflowExecutionPolicy } from '@graphql/contracts'
import { focusFirstInvalid } from '../settings/fieldValidation'
import '../settings/settingsUsability.css'

export function WorkflowExecutionLimits({ value, nodeCount, onApply }: {
  value: WorkflowExecutionPolicy
  nodeCount: number
  onApply(value: WorkflowExecutionPolicy): void
}) {
  const minimum = Math.max(1, nodeCount)
  const [nodeLimit, setNodeLimit] = useState(String(value.maxNodeExecutions))
  const [parallelism, setParallelism] = useState(String(value.maxParallelism))
  const [applied, setApplied] = useState(false)
  const prefix = useId()
  const root = useRef<HTMLFieldSetElement>(null)
  const nodeValue = Number(nodeLimit)
  const parallelValue = Number(parallelism)
  const invalidNode = !nodeLimit.trim() || !Number.isInteger(nodeValue) || nodeValue < minimum || nodeValue > 10_000
  const invalidParallel = !parallelism.trim() || !Number.isInteger(parallelValue) || parallelValue < 1 || parallelValue > 100
  return <fieldset ref={root} className="workflow-execution-limits"><legend>Workflow execution limits</legend>
    <p>These limits apply to the entire workflow, not one agent.</p>
    <label>Maximum node executions<input aria-label="Maximum node executions" type="number" min={minimum} max={10_000} step={1} value={nodeLimit}
      aria-invalid={invalidNode ? true : undefined} aria-describedby={`${prefix}-nodes-help`} onChange={(event) => { setNodeLimit(event.target.value); setApplied(false) }} />
      <small id={`${prefix}-nodes-help`} className={invalidNode ? 'settings-field-error' : undefined}>Enter a whole number between {minimum} and 10,000, enough for every node.</small></label>
    <label>Maximum parallel agents<input aria-label="Maximum parallel agents" type="number" min={1} max={100} step={1} value={parallelism}
      aria-invalid={invalidParallel ? true : undefined} aria-describedby={`${prefix}-parallel-help`} onChange={(event) => { setParallelism(event.target.value); setApplied(false) }} />
      <small id={`${prefix}-parallel-help`} className={invalidParallel ? 'settings-field-error' : undefined}>Enter a whole number between 1 and 100.</small></label>
    <button type="button" onClick={() => {
      if (invalidNode || invalidParallel) { window.requestAnimationFrame(() => focusFirstInvalid(root.current)); return }
      onApply({ maxNodeExecutions: nodeValue, maxParallelism: parallelValue })
      setApplied(true)
    }}>Apply workflow limits to draft</button>
    {applied ? <p role="status">Workflow limits applied to the draft. Use Save graph to persist them.</p> : null}
  </fieldset>
}
