import {
  DEFAULT_CODEX_ADVANCED_CONFIGURATION,
  DEFAULT_HARNESS_DEFAULTS,
  DEFAULT_OPENCODE_ADVANCED_CONFIGURATION,
  type AgentDefaults, type AgentProductRole, type CodexAdvancedConfiguration,
  type HarnessConfiguration, type OpenCodeAdvancedConfiguration,
} from '@graphql/contracts'
import { Bot, Code2, RadioTower } from 'lucide-react'

import { useAgentDefaultsQuery, useUpdateAgentDefaultsMutation } from '../../shared/api/query'
import { useRevisionedForm } from './revisionedForm'

const roles: Array<{ id: AgentProductRole; title: string; copy: string; icon: typeof Bot }> = [
  { id: 'orchestrator', title: 'Orchestrator', copy: 'Coordinates a workflow and may review its Coder requests.', icon: RadioTower },
  { id: 'coder', title: 'Coder', copy: 'Executes workflow work using copied provider defaults.', icon: Code2 },
  { id: 'operator', title: 'Operator', copy: 'Application-level management Agent. Never appears on a board.', icon: Bot },
]

function HarnessFields({ value, onChange }: { value: HarnessConfiguration; onChange(value: HarnessConfiguration): void }) {
  const advanced = (value.advanced ?? (value.harness === 'codex'
    ? DEFAULT_CODEX_ADVANCED_CONFIGURATION
    : DEFAULT_OPENCODE_ADVANCED_CONFIGURATION)) as CodexAdvancedConfiguration & OpenCodeAdvancedConfiguration
  return <>
    <label>Harness<select value={value.harness} onChange={(event) => {
      onChange(event.target.value === 'codex' ? structuredClone(DEFAULT_HARNESS_DEFAULTS.codex) : structuredClone(DEFAULT_HARNESS_DEFAULTS.opencode))
    }}><option value="codex">Codex</option><option value="opencode">OpenCode</option></select></label>
    <label>Model<input value={value.model} onChange={(event) => onChange({ ...value, model: event.target.value })} /></label>
    {value.harness === 'codex' ? <>
      <label>Reasoning effort<select value={value.reasoningEffort} onChange={(event) => onChange({ ...value, reasoningEffort: event.target.value as typeof value.reasoningEffort })}>
        {['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((item) => <option key={item} value={item}>{item}</option>)}
      </select></label>
      <label>Sandbox<select value={value.sandbox} onChange={(event) => onChange({ ...value, sandbox: event.target.value as typeof value.sandbox })}>
        <option value="read-only">Read only</option><option value="workspace-write">Workspace write</option><option value="danger-full-access">Full access</option>
      </select></label>
    </> : <>
      <label>Provider variant<input value={value.variant} onChange={(event) => onChange({ ...value, variant: event.target.value })} /></label>
      <label>Native Agent<input value={value.nativeAgent} onChange={(event) => onChange({ ...value, nativeAgent: event.target.value })} /></label>
      <label className="settings-switch settings-switch-inline"><input type="checkbox" checked={value.thinking} onChange={(event) => onChange({ ...value, thinking: event.target.checked })} /><span><strong>Show thinking</strong><small>Controls reasoning-block visibility, not reasoning effort.</small></span></label>
      <p className="settings-help"><strong>Auto approve:</strong> OpenCode automatically approves eligible permission requests. It does not use a separate reviewer agent.</p>
    </>}
    <details className="advanced-settings"><summary>Advanced</summary>{value.harness === 'codex' ? <div className="settings-field-grid">
      <label>Approval policy<select value={advanced.approvalPolicy} onChange={(event) => onChange({ ...value, advanced: { ...advanced, approvalPolicy: event.target.value as typeof advanced.approvalPolicy } })}><option value="on-request">On request</option><option value="never">Never</option></select></label>
      <label>Approval reviewer<select value={advanced.approvalsReviewer} onChange={(event) => onChange({ ...value, advanced: { ...advanced, approvalsReviewer: event.target.value as typeof advanced.approvalsReviewer } })}><option value="user">GraphQL routed</option><option value="auto_review">Native AI reviewer</option></select><small>Native AI reviewer: Codex uses its own reviewer to evaluate eligible approval requests.</small></label>
      <label>Additional writable directories<textarea rows={3} value={advanced.additionalWritableDirectories.join('\n')} placeholder="One absolute path per line" onChange={(event) => onChange({ ...value, advanced: { ...advanced, additionalWritableDirectories: event.target.value.split('\n').map((item) => item.trim()).filter(Boolean) } })} /><small>Expands permissions; it does not change the workspace root.</small></label>
      <label>Session<select value={advanced.sessionPersistence} onChange={(event) => onChange({ ...value, advanced: { ...advanced, sessionPersistence: event.target.value as typeof advanced.sessionPersistence } })}><option value="persistent">Persistent</option><option value="ephemeral">Ephemeral</option></select></label>
      <label>Web search<select value={advanced.webSearch} onChange={(event) => onChange({ ...value, advanced: { ...advanced, webSearch: event.target.value as typeof advanced.webSearch } })}><option value="disabled">Disabled</option><option value="cached">Cached</option><option value="live">Live</option></select></label>
      <label className="settings-switch settings-switch-inline"><input type="checkbox" checked={advanced.workspaceWrite?.networkAccess ?? false} disabled={value.sandbox !== 'workspace-write'} onChange={(event) => onChange({ ...value, advanced: { ...advanced, workspaceWrite: { networkAccess: event.target.checked, excludeTmpdirEnvVar: advanced.workspaceWrite?.excludeTmpdirEnvVar ?? false, excludeSlashTmp: advanced.workspaceWrite?.excludeSlashTmp ?? false } } })} /><span><strong>Workspace network access</strong><small>Requires workspace-write sandbox.</small></span></label>
    </div> : <div className="settings-field-grid">
      <label>Permission handling<select value={advanced.permissionHandling} onChange={(event) => { const permissionHandling = event.target.value as typeof advanced.permissionHandling; onChange({ ...value, autoApprove: permissionHandling === 'native_auto', advanced: { ...advanced, permissionHandling } }) }}><option value="graphql_routed">GraphQL routed review</option><option value="native_auto">Native auto approve</option></select></label>
      <label>Plugin loading<select value={advanced.plugins.mode} onChange={(event) => onChange({ ...value, advanced: { ...advanced, plugins: { mode: event.target.value as 'inherit' | 'pure' } } })}><option value="inherit">Inherit</option><option value="pure">Pure</option></select></label>
      <label className="settings-switch settings-switch-inline"><input type="checkbox" checked={advanced.compaction.auto} onChange={(event) => onChange({ ...value, advanced: { ...advanced, compaction: { ...advanced.compaction, auto: event.target.checked } } })} /><span><strong>Automatic compaction</strong></span></label>
      <fieldset className="permission-rules"><legend>Ordered permission rules</legend>{advanced.permissionRules.length === 0 ? <p>Default native policy</p> : advanced.permissionRules.map((rule, index) => <div key={`${index}-${rule.permission}`}>
        <input aria-label={`Permission ${index + 1}`} value={rule.permission} onChange={(event) => onChange({ ...value, advanced: { ...advanced, permissionRules: advanced.permissionRules.map((item, itemIndex) => itemIndex === index ? { ...item, permission: event.target.value } : item) } })} />
        <input aria-label={`Pattern ${index + 1}`} value={rule.pattern} onChange={(event) => onChange({ ...value, advanced: { ...advanced, permissionRules: advanced.permissionRules.map((item, itemIndex) => itemIndex === index ? { ...item, pattern: event.target.value } : item) } })} />
        <select aria-label={`Effect ${index + 1}`} value={rule.effect} onChange={(event) => onChange({ ...value, advanced: { ...advanced, permissionRules: advanced.permissionRules.map((item, itemIndex) => itemIndex === index ? { ...item, effect: event.target.value as typeof item.effect } : item) } })}><option value="allow">Allow</option><option value="ask">Ask</option><option value="deny">Deny</option></select>
        <button type="button" onClick={() => onChange({ ...value, advanced: { ...advanced, permissionRules: advanced.permissionRules.filter((_, itemIndex) => itemIndex !== index) } })}>Remove</button>
      </div>)}<button type="button" onClick={() => onChange({ ...value, advanced: { ...advanced, permissionRules: [...advanced.permissionRules, { permission: 'shell', pattern: '*', effect: 'ask' }] } })}>Add custom rule</button><small>Rules retain order and patterns exactly; complex policies remain Custom.</small></fieldset>
    </div>}</details>
  </>
}

export function AgentDefaultsSettings() {
  const query = useAgentDefaultsQuery()
  const mutation = useUpdateAgentDefaultsMutation()
  const { draft, baseRevision, isDirty, conflicted, setDraft, acknowledge, reset } = useRevisionedForm<AgentDefaults>(query.data
    ? { value: query.data.value, revision: query.data.revision } : undefined)

  if (query.isPending || !draft) return <p className="settings-state" role="status">Loading Agent defaults…</p>
  if (query.isError) return <p className="settings-state" role="alert">Agent defaults are unavailable.</p>

  return <section className="settings-form" aria-labelledby="agent-defaults-title">
    <header className="settings-form-heading"><div><p className="panel-kicker">Templates</p><h2 id="agent-defaults-title">Agent defaults</h2><p>Copied into new Agents. Existing Agents and accepted runs stay pinned.</p></div>
      <button type="button" disabled={!isDirty || mutation.isPending} onClick={async () => {
        const submitted = draft
        const response = await mutation.mutateAsync({ value: submitted, expectedRevision: baseRevision!, commandId: crypto.randomUUID() })
        acknowledge(submitted, response.value.value, response.value.revision)
      }}>{mutation.isPending ? 'Saving…' : 'Save defaults'}</button></header>
    {conflicted ? <div className="settings-conflict" role="alert">These defaults changed elsewhere. Your edits were preserved.<button type="button" onClick={reset}>Load current defaults</button></div> : null}
    {mutation.isError ? <p role="alert">{mutation.error.message}</p> : null}
    <div className="agent-template-grid">
      {roles.map(({ id, title, copy, icon: Icon }) => {
        const template = draft[id]
        return <article className="agent-template-card" key={id}>
          <div className="agent-template-title"><span><Icon size={18} /></span><div><h3>{title}</h3><p>{copy}</p></div></div>
          <div className="settings-field-grid"><HarnessFields value={template.harness} onChange={(harness) => setDraft((current) => current && ({ ...current, [id]: { ...current[id], harness } }))} /></div>
          {id === 'operator' ? <label className="settings-switch"><input type="checkbox" checked={draft.operator.uiEnabled} onChange={(event) => setDraft((current) => current && ({ ...current, operator: { ...current.operator, uiEnabled: event.target.checked } }))} /><span><strong>Enable Operator UI</strong><small>Controls the in-app surface only. Operator MCP remains available.</small></span></label> : null}
          {id !== 'operator' ? <p className="settings-capability">Board template · {template.boardAddable ? 'Available' : 'Unavailable'}</p> : <p className="settings-capability">Application Agent · Board insertion forbidden</p>}
        </article>
      })}
    </div>
  </section>
}
