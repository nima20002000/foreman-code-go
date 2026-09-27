import { useState } from 'react'
import { AgentDefaultsSchema, type AgentDefaults } from '@graphql/contracts'
import type { HarnessSettingsSection, SettingsAgentRole } from '@graphql/contracts/management'
import { Button, Checkbox, ErrorState, LoadingState } from '../../shared/ui/nocturne'
import { useAgentDefaultsQuery, useUpdateAgentDefaultsMutation } from '../../shared/api/query'
import { HarnessConfigurationFields } from './HarnessConfigurationFields'
import { createHarnessEditor, prepareHarnessEditor, type HarnessEditor } from './harnessEditor'
import { issuesAt, withValidationPath } from './fieldValidation'
import { SettingsFormActions, SettingsFormFeedback } from './SettingsFormActions'
import { useSettingsValidation } from './useSettingsValidation'
import { AgentSkillsField } from '../skills/AgentSkillsField'
import { useRevisionedForm, useSettingsDraftStatus } from './revisionedForm'
import { SettingsChoice, SettingsEditorLayout, SettingsOverview } from './SettingsEditorLayout'
import { agentRoleOrder, harnessSummary, rolePresentation } from './settingsPresentation'

type DefaultsEditor = { [Role in keyof AgentDefaults]: Omit<AgentDefaults[Role], 'harness'> & { harness: HarnessEditor } }
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
function RoleCard({ role, value, onSelect }: { role: SettingsAgentRole; value: AgentDefaults; onSelect(): void }) {
  const status = useSettingsDraftStatus(`settings:agents:${role}`)
  return <SettingsChoice title={rolePresentation[role].title} description={rolePresentation[role].description}
    summary={harnessSummary(value[role].harness)} draftStatus={status} onSelect={onSelect} />
}
export function AgentDefaultsSettings({ selectedRole, section: selectedSection, onSelectRole, onSectionChange }: {
  selectedRole?: SettingsAgentRole; section?: HarnessSettingsSection;
  onSelectRole?(role: SettingsAgentRole | undefined): void; onSectionChange?(section: HarnessSettingsSection): void;
}) {
  const [localRole, setLocalRole] = useState<SettingsAgentRole>()
  const [localSection, setLocalSection] = useState<HarnessSettingsSection>('model')
  const query = useAgentDefaultsQuery()
  const role = onSelectRole ? selectedRole : localRole
  const section = selectedSection ?? localSection
  const choose = (next: SettingsAgentRole | undefined) => { setLocalRole(next); setLocalSection('model'); onSelectRole?.(next) }
  const navigateSection = (next: HarnessSettingsSection) => { setLocalSection(next); onSectionChange?.(next) }
  if (role) return <AgentTemplateEditor showBack={!onSelectRole} key={role} role={role} section={section} onSectionChange={navigateSection} onBack={() => choose(undefined)} />
  if (query.isError) return <ErrorState title="Agent defaults are unavailable" description={query.error.message} onRetry={() => void query.refetch()} />
  if (!query.data) return <LoadingState label="Loading agent defaults…" />
  return <SettingsOverview title="Agents" description="Choose a role to edit its defaults.">
    {agentRoleOrder.map((item) => <RoleCard key={item} role={item} value={query.data.value} onSelect={() => choose(item)} />)}
  </SettingsOverview>
}

function AgentTemplateEditor({ role, section, onSectionChange, onBack, showBack }: {
  role: SettingsAgentRole; section: HarnessSettingsSection; onSectionChange(section: HarnessSettingsSection): void; onBack(): void; showBack: boolean;
}) {
  const query = useAgentDefaultsQuery()
  const mutation = useUpdateAgentDefaultsMutation()
  // Each role retains its own full revisioned snapshot. Only this role is editable here.
  // A concurrent save of another role causes a revision conflict, never a blind overwrite.
  const form = useRevisionedForm<DefaultsEditor>(query.data ? { value: editable(query.data.value), revision: query.data.revision } : undefined, `settings:agents:${role}`)
  const root = useSettingsValidation(form.issues)
  const draft = form.draft
  if (query.isError && !draft) return <ErrorState title="Agent defaults are unavailable" description={query.error.message} onRetry={() => void query.refetch()} />
  if (!draft) return <LoadingState label="Loading agent defaults…" />
  const current = draft[role].harness
  const info = rolePresentation[role]
  const update = (harness: HarnessEditor) => form.setDraft((value) => value && ({ ...value, [role]: { ...value[role], harness } }))
  return <div ref={(node) => { root.current = node }}>
    <SettingsEditorLayout showBack={showBack} title={`${info.title} defaults`} description={info.scope} backLabel="All agents" onBack={onBack}
      section={section} onSectionChange={onSectionChange}
      feedback={<>{query.isError ? <p role="alert">Could not refresh. Your draft is kept. <Button size="sm" onClick={() => void query.refetch()}>Retry</Button></p> : null}<SettingsFormFeedback form={form} /></>}
      footer={<SettingsFormActions form={form} saveLabel={`Save ${info.title}`}
        onSave={() => form.save(async (input) => {
          const response = await mutation.mutateAsync({ ...input, value: prepared(input.value) })
          return { value: editable(response.value.value), revision: response.value.revision }
        }, (value) => { prepared(value); return value })} />}>
      <HarnessConfigurationFields editor={current} issues={issuesAt(form.issues ?? [], [role, 'harness'])}
        routedApproval={role !== 'operator'} requiresResume onChange={update} section={section}
        onSectionChange={onSectionChange} compact frameless />
      {role === 'operator' && section === 'model' ? <div className="settings-simple-row"><Checkbox label="Show Operator chat"
        hint="Show or hide the chat interface. This does not revoke the Operator’s access."
        checked={draft.operator.uiEnabled} onChange={(event) => form.setDraft((value) => value && ({ ...value,
          operator: { ...value.operator, uiEnabled: event.target.checked } }))} /></div> : null}
      {role === 'operator' && section === 'model' ? <div className="settings-simple-row"><AgentSkillsField acrossWorkspaces
        value={draft.operator.assignedSkills ?? []} onChange={(assignedSkills) => form.setDraft((value) => value && ({ ...value,
          operator: { ...value.operator, assignedSkills } }))} /></div> : null}
      {role === 'operator' && section === 'model' && current.configuration.harness === 'codex' ? <div className="settings-simple-row"><Checkbox label="Show thinking"
        checked={draft.operator.showThinking ?? false} onChange={(event) => form.setDraft((value) => value && ({ ...value,
          operator: { ...value.operator, showThinking: event.target.checked } }))} /></div> : null}
    </SettingsEditorLayout>
  </div>
}
