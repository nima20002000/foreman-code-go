import type { SavedNodePlacement } from '@foreman-code/contracts/node-placement'
import { sameWorkflowValue } from '@foreman-code/contracts/wave25'
import { Select } from '../../shared/ui/nocturne'

/** Presentation only. The caller supplies authorized, revision-pinned choices;
 * this control never discovers hosts, validates remote paths or creates pins. */
export type NodePlacementOption = Readonly<{
  placement: SavedNodePlacement
  label: string
  unavailableReason?: string
}>
export type NodePlacementFieldProps = {
  value?: SavedNodePlacement
  options: readonly NodePlacementOption[]
  onChange(value: SavedNodePlacement): void
  disabled?: boolean
  optionsState?: 'ready' | 'loading' | 'unavailable'
  stage?: 'editing' | 'draft' | 'saved'
}
export function NodePlacementField({ value, options, onChange, disabled, optionsState = 'ready', stage }: NodePlacementFieldProps) {
  const selected = value ? options.findIndex((option) => sameWorkflowValue(option.placement, value)) : -1
  const current = selected >= 0 ? options[selected] : undefined
  return <div className="node-placement-field">
    <Select label="Computer" aria-label="Computer" value={selected < 0 ? 'retained' : String(selected)} disabled={disabled}
      options={[
        ...(selected < 0 ? [{ value: 'retained', label: value ? 'Configured computer — retained' : 'Choose a computer', disabled: true }] : []),
        ...options.map((option, index) => ({ value: String(index), label: option.unavailableReason ? `${option.label} — ${option.unavailableReason}` : option.label, disabled: !!option.unavailableReason })),
      ]} onChange={(event) => {
        const option = options[Number(event.target.value)]
        if (option && !option.unavailableReason) onChange(structuredClone(option.placement))
      }} />
    {value && stage ? <p role="status">{stage === 'editing' ? 'Editing computer choice — Apply to this node’s draft.' : stage === 'draft' ? 'Applied to draft — Save graph to persist this placement.' : 'Persisted Board placement — configured for a later Run.'}</p> : null}
    <p>Once any Agent has a computer choice, choose a computer with an approved source and root for every Agent,
      including Agents on Main. Save the graph before starting.</p>
    {value ? <>
      <dl>
        <dt>Configured for next Run</dt><dd>{current?.label ?? (optionsState === 'ready' ? 'Unavailable configured choice' : 'Configured choice retained')}</dd>
        <dt>Execution root</dt><dd>{value.projectRoot}</dd>
      </dl>
      <details><summary>Computer and harness identities</summary><dl>
        <dt>Computer identity</dt><dd><code>{value.hostRef.kind === 'device' ? value.hostRef.deviceId : value.hostRef.mainId}</code></dd>
        <dt>Harness instance</dt><dd>{value.instanceId} · revision {value.instanceRevision}</dd>
        <dt>Harness installation</dt><dd>{value.harnessInstallationId}</dd>
        <dt>Root policy</dt><dd>{value.rootPolicyId} · revision {value.rootPolicyRevision}</dd>
      </dl></details>
    </> : <p>No computer chosen yet. Choose one above to place this node.</p>}
    {optionsState === 'loading' ? <p role="status">Reading authorized computer choices…</p> : optionsState === 'unavailable' ? <p role="status">Authorized computer choices are unavailable. Configured placement is retained.</p> : null}
    {optionsState === 'ready' && value && (!current || current.unavailableReason) ? <p role="status">{current?.unavailableReason ?? 'This configured choice is no longer available. It is retained until you explicitly replace it.'}</p> : null}
    {stage ? null : <p>Apply changes this node’s draft. Save graph persists it for a later Run. An accepted Run keeps its original placement.</p>}
  </div>
}
