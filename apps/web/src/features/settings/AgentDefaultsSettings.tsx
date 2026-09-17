import { AgentDefaultsSchema, type AgentDefaults } from '@graphql/contracts'

import { useAgentDefaultsQuery, useUpdateAgentDefaultsMutation } from '../../shared/api/query'
import { HarnessConfigurationFields } from './HarnessConfigurationFields'
import { createHarnessEditor, prepareHarnessEditor, type HarnessEditor } from './harnessEditor'
import { issuesAt, withValidationPath } from './fieldValidation'
import { SettingsFormActions, SettingsFormFeedback } from './SettingsFormActions'
import { useSettingsValidation } from './useSettingsValidation'
import { useRevisionedForm } from './revisionedForm'

type DefaultsEditor = { [Role in keyof AgentDefaults]: Omit<AgentDefaults[Role], 'harness'> & { harness: HarnessEditor } }
const roles = ['orchestrator', 'coder', 'operator'] as const
function editable(value: AgentDefaults): DefaultsEditor {
  return {
    orchestrator: { ...value.orchestrator, harness: createHarnessEditor(value.orchestrator.harness) },
    coder: { ...value.coder, harness: createHarnessEditor(value.coder.harness) },
    operator: { ...value.operator, harness: createHarnessEditor(value.operator.harness) },
  }
}
function prepared(value: DefaultsEditor): AgentDefaults {
  return AgentDefaultsSchema.parse({
    orchestrator: { ...value.orchestrator, harness: withValidationPath(['orchestrator', 'harness'], () => prepareHarnessEditor(value.orchestrator.harness)) },
    coder: { ...value.coder, harness: withValidationPath(['coder', 'harness'], () => prepareHarnessEditor(value.coder.harness)) },
    operator: { ...value.operator, harness: withValidationPath(['operator', 'harness'], () => prepareHarnessEditor(value.operator.harness)) },
  })
}

export function AgentDefaultsSettings() {
  const query = useAgentDefaultsQuery()
  const mutation = useUpdateAgentDefaultsMutation()
  const form = useRevisionedForm<DefaultsEditor>(query.data
    ? { value: editable(query.data.value), revision: query.data.revision } : undefined, 'settings:agents')
  const root = useSettingsValidation(form.issues)
  const draft = form.draft
  if (query.isError && !draft) return <div role="alert"><p>Agent defaults are unavailable. {query.error.message}</p><button type="button" onClick={() => void query.refetch()}>Retry</button></div>
  if (!draft) return <p role="status">Loading Agent defaults…</p>
  return <section ref={root} className="settings-form" aria-labelledby="agent-defaults-title">
    <header className="settings-form-heading"><div><p className="panel-kicker">Templates</p><h2 id="agent-defaults-title">Agent defaults</h2><p>Copied into new Agents. Existing Agents and accepted runs stay pinned.</p></div></header>
    {query.isError ? <p role="alert">The refresh failed. Your draft is preserved. <button type="button" onClick={() => void query.refetch()}>Retry refresh</button></p> : null}
    <SettingsFormFeedback form={form} />
    <div className="agent-template-grid">{roles.map((role) => <article className="agent-template-card" key={role}>
      <h3>{role === 'orchestrator' ? 'Orchestrator' : role === 'coder' ? 'Coder' : 'Operator'}</h3>
      <div className="settings-field-grid"><HarnessConfigurationFields editor={draft[role].harness} issues={issuesAt(form.issues ?? [], [role, 'harness'])} routedApproval={role !== 'operator'} onChange={(harness) => form.setDraft((current) => current && ({ ...current, [role]: { ...current[role], harness } }))} /></div>
      {role === 'operator' ? <label className="settings-switch"><input type="checkbox" checked={draft.operator.uiEnabled} onChange={(event) => form.setDraft((current) => current && ({ ...current, operator: { ...current.operator, uiEnabled: event.target.checked } }))} /><span><strong>Enable Operator UI</strong><small>Controls the in-app surface only. Operator MCP remains available.</small></span></label> : null}
      <p>{role === 'operator' ? 'Application Agent · Board insertion forbidden' : 'Board template · Available'}</p>
    </article>)}</div>
    <SettingsFormActions form={form} onSave={() => void form.save(async (input) => {
      const response = await mutation.mutateAsync({ ...input, value: prepared(input.value) })
      return { value: editable(response.value.value), revision: response.value.revision }
    }, (value) => { prepared(value); return value })} />
  </section>
}
