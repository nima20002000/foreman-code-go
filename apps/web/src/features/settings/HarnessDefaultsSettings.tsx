import { useState } from 'react'
import { type HarnessDefaults, type AgentHarness, type ClaudeHarnessConfiguration, ClaudeHarnessConfigurationSchema, HarnessDefaultsSchema } from '@foreman-code/contracts'
import { HarnessDefaultsUpdateInputSchema, ManagementHarnessDefaultsSchema, type HarnessSettingsSection } from '@foreman-code/contracts/management'
import { Alert, Button, Checkbox, ErrorState, LoadingState, Select, TextField } from '../../shared/ui/nocturne'
import { useManagedHarnessCatalogQuery, useUpdateManagedHarnessDefaultsMutation } from '../../shared/api/query'
import { HarnessConfigurationFields } from './HarnessConfigurationFields'
import { HarnessCompatibilityPanel } from './HarnessCompatibilityPanel'
import { createHarnessEditor, prepareHarnessEditor, type HarnessEditor } from './harnessEditor'
import { issuesAt, withValidationPath, fieldMessage, type FieldIssue } from './fieldValidation'
import { SettingsFormActions, SettingsFormFeedback } from './SettingsFormActions'
import { useSettingsValidation } from './useSettingsValidation'
import { useRevisionedForm, useSettingsDraftStatus } from './revisionedForm'
import { SettingsChoice, SettingsEditorLayout, SettingsOverview } from './SettingsEditorLayout'
import { harnessNames, harnessSummary } from './settingsPresentation'
import { CodexPluginManager } from './CodexPluginManager'
import { useClaudeSetupOptions } from '../../shared/api/harnessSettings'

type Harness = AgentHarness
type ClaudeSetup = Partial<Pick<ClaudeHarnessConfiguration, 'model' | 'configDirectory' | 'authMode' | 'sandbox' | 'mcpServers'>>
type DefaultsEditor = { codex: HarnessEditor; opencode: HarnessEditor; claude?: HarnessEditor; claudeSetup?: ClaudeSetup }
function editable(value: HarnessDefaults, harness?: Harness): DefaultsEditor {
  return { codex: createHarnessEditor(value.codex), opencode: createHarnessEditor(value.opencode),
    ...(value.claude ? { claude: createHarnessEditor(value.claude) } : harness === 'claude' ? { claudeSetup: {} } : {}) }
}
function prepared(value: DefaultsEditor): HarnessDefaults {
  return HarnessDefaultsSchema.parse({
    codex: withValidationPath(['codex'], () => prepareHarnessEditor(value.codex)),
    opencode: withValidationPath(['opencode'], () => prepareHarnessEditor(value.opencode)),
    ...(value.claude ? { claude: withValidationPath(['claude'], () => prepareHarnessEditor(value.claude!)) }
      : value.claudeSetup ? { claude: withValidationPath(['claude'], () => ClaudeHarnessConfigurationSchema.parse({
        harness: 'claude', permissionMode: 'default', tools: [], permissionRules: [], instructions: '', mcpServers: {}, ...value.claudeSetup,
      })) } : {}),
  })
}
function useProviderDefaults() {
  const catalogQuery = useManagedHarnessCatalogQuery(true)
  const unavailable: Partial<Record<Harness, string>> = {}
  for (const entry of catalogQuery.data ?? []) {
    if (entry.discoveryError && ['HARNESS_MODEL_DEFAULT_UNAVAILABLE',
      'CLAUDE_FULL_ACCESS_REQUIRED', 'CLAUDE_EXTERNAL_MCP_UNSUPPORTED'].includes(entry.discoveryError.code)) {
      unavailable[entry.harness] = entry.discoveryError.message
    }
  }
  const codex = catalogQuery.data?.find((entry) => entry.harness === 'codex')
  const opencode = catalogQuery.data?.find((entry) => entry.harness === 'opencode')
  const claude = catalogQuery.data?.find((entry) => entry.harness === 'claude')
  const incoming = codex?.defaults.harness === 'codex' && opencode?.defaults.harness === 'opencode' && codex.defaultsRevision === opencode.defaultsRevision && (!claude || (claude.defaults.harness === 'claude' && claude.defaultsRevision === codex.defaultsRevision))
    ? { value: { codex: codex.defaults, opencode: opencode.defaults, ...(claude?.defaults.harness === 'claude' ? { claude: claude.defaults } : {}) }, revision: codex.defaultsRevision }
    : undefined
  return { incoming, query: catalogQuery, unavailable }
}
function ProviderCard({ harness, value, onSelect, defaultError }: {
  harness: Harness; value: HarnessDefaults; onSelect(): void; defaultError: string | undefined
}) {
  const status = useSettingsDraftStatus(`settings:harnesses:${harness}`)
  const summary = value[harness] ? harnessSummary(value[harness]!).filter((item) => item.label !== 'Harness')
    : [{ label: 'Preset', value: 'Not configured' }]
  return <SettingsChoice icon="settings" title={harnessNames[harness]}
    description={harness === 'codex' ? 'Native app-server' : harness === 'opencode' ? 'Native server' : 'Host-local Claude profile'}
    summary={defaultError ? [{ label: 'Default model', value: 'Unavailable' }] : summary}
    draftStatus={status} onSelect={onSelect} />
}
export function HarnessDefaultsSettings({ selectedHarness, section: selectedSection, onSelectHarness, onSectionChange }: {
  selectedHarness?: Harness; section?: HarnessSettingsSection;
  onSelectHarness?(harness: Harness | undefined): void; onSectionChange?(section: HarnessSettingsSection): void;
}) {
  const { incoming, query, unavailable } = useProviderDefaults()
  const [localHarness, setLocalHarness] = useState<Harness>()
  const [localSection, setLocalSection] = useState<HarnessSettingsSection>('model')
  const harness = onSelectHarness ? selectedHarness : localHarness
  const section = selectedSection ?? localSection
  const choose = (next: Harness | undefined) => { setLocalHarness(next); setLocalSection('model'); onSelectHarness?.(next) }
  const navigateSection = (next: HarnessSettingsSection) => { setLocalSection(next); onSectionChange?.(next) }
  if (harness) return <ProviderEditor showBack={!onSelectHarness} key={harness} harness={harness} section={section} onSectionChange={navigateSection} onBack={() => choose(undefined)} />
  if (query.isError || (query.isSuccess && !incoming)) return <ErrorState title="Harness defaults are unavailable"
    description={query.error?.message ?? 'The server returned an incomplete provider catalog.'} onRetry={() => void query.refetch()} />
  if (!incoming) return <LoadingState label="Loading harness defaults…" />
  return <SettingsOverview title="Harnesses" description="Choose a provider to edit its preset or manage its connections.">
    {(['codex', 'opencode', 'claude'] as const).map((item) => <ProviderCard key={item} harness={item} value={incoming.value}
      defaultError={unavailable[item]} onSelect={() => choose(item)} />)}
  </SettingsOverview>
}
function ProviderEditor({ harness, section, onSectionChange, onBack, showBack }: {
  harness: Harness; section: HarnessSettingsSection; onSectionChange(section: HarnessSettingsSection): void; onBack(): void; showBack: boolean;
}) {
  const { incoming, query, unavailable } = useProviderDefaults()
  const form = useRevisionedForm<DefaultsEditor>(incoming ? { value: editable(incoming.value, harness), revision: incoming.revision } : undefined, `settings:harnesses:${harness}`)
  const managedSave = useUpdateManagedHarnessDefaultsMutation()
  const root = useSettingsValidation(form.issues)
  const draft = form.draft
  const name = harnessNames[harness]
  const activeSection = harness !== 'codex' && section === 'plugins' ? 'model' : section
  if (!draft && (query.isError || (query.isSuccess && !incoming))) return <ErrorState title="Harness defaults are unavailable" description={query.error?.message ?? 'The server returned an incomplete provider catalog.'} onRetry={() => void query.refetch()} />
  if (!draft) return <LoadingState label="Loading provider defaults…" />
  const update = (next: HarnessEditor) => form.setDraft((current) => current && ({ ...current, [harness]: next }))
  const reapply = () => {
    if (!form.conflicted || form.isSaving || form.uncertain) return
    form.reapply()
    form.setDraft((current) => {
      if (!current?.claudeSetup || current.claude?.configuration.harness !== 'claude') return current
      const { claudeSetup, ...next } = current
      // Setup fields and a newly saved preset describe one provider, not two competing drafts.
      return { ...next, claude: { ...current.claude, configuration: { ...current.claude.configuration, ...claudeSetup } } }
    })
  }
  return <div ref={(node) => { root.current = node }}><SettingsEditorLayout showBack={showBack} title={`${name} settings`}
    backLabel="All harnesses" onBack={onBack} section={activeSection} onSectionChange={onSectionChange} connections plugins={harness === 'codex'}
    feedback={<>{unavailable[harness] ? <Alert tone="warning" title="Preset needs configuration">{unavailable[harness]}</Alert> : null}
      {query.isError ? <p role="alert">Could not refresh. Your draft is kept. <Button size="sm" onClick={() => void query.refetch()}>Retry</Button></p> : null}<SettingsFormFeedback form={{ ...form, reapply }} /></>}
    footer={(activeSection === 'connections' && harness !== 'claude') || activeSection === 'workspace' || activeSection === 'plugins' ? null : <SettingsFormActions form={form} saveLabel={`Save ${name} preset`}
      onSave={() => form.save(async (input) => {
        const defaults = prepared(input.value)
        const response = await managedSave.mutateAsync({ defaults: HarnessDefaultsUpdateInputSchema.shape.defaults.parse(defaults),
          configure: [harness], expectedRevision: input.expectedRevision, commandId: input.commandId })
        return { value: editable(response.value.defaults, harness), revision: response.value.revision }
      }, (value) => { ManagementHarnessDefaultsSchema.parse(prepared(value)); return value })} />}>
    {section === 'workspace' && harness !== 'claude' ? <HarnessCompatibilityPanel harness={harness} /> : null}
    {harness === 'codex' && section === 'permissions' ? <section aria-label="Supported Codex requests">
      <h3>Supported requests</h3>
      {query.data?.find((entry) => entry.harness === 'codex')?.interactionSupport?.map((support) => <div key={support.kind}>
        <h4>{support.label}</h4><p>{support.supported}</p><p>{support.unsupported}</p>
      </div>)}
    </section> : null}
    {harness === 'claude' && !draft.claude ? <ClaudePresetSetup value={draft.claudeSetup ?? {}} issues={issuesAt(form.issues ?? [], ['claude'])}
      onChange={(claudeSetup) => form.setDraft((current) => current && ({ ...current, claudeSetup }))} />
      : section === 'plugins' && harness === 'codex' ? <CodexPluginManager /> : <HarnessConfigurationFields allowHarnessChange={false} editor={draft[harness]!} onChange={update} issues={issuesAt(form.issues ?? [], [harness])}
      section={activeSection} onSectionChange={onSectionChange} frameless />}
  </SettingsEditorLayout></div>
}

function ClaudePresetSetup({ value, onChange, issues }: { value: ClaudeSetup; onChange(value: ClaudeSetup): void; issues: readonly FieldIssue[] }) {
  const setup = useClaudeSetupOptions()
  return <div className="harness-basic-fields">
    <p>Claude has no saved preset.</p><p>Enter an actual profile on the selected computer and choose a model, authentication and sandbox explicitly. New presets enable no tools; approvals use app routing.</p>
    <TextField label="Model" value={value.model ?? ''} error={fieldMessage(issues, 'model')} className="harness-model-secondary"
      onChange={(event) => onChange({ ...value, model: event.target.value })} />
    <TextField label="Local Claude profile directory" value={value.configDirectory ?? ''} error={fieldMessage(issues, 'configDirectory')}
      onChange={(event) => onChange({ ...value, configDirectory: event.target.value })} />
    <Select label="Authentication" value={value.authMode ?? ''} error={fieldMessage(issues, 'authMode')}
      options={[{ value: '', label: 'Choose authentication', disabled: true }, { value: 'subscription', label: 'Local Claude subscription login' }, { value: 'api-key', label: 'Explicit API key · separate billing' }]}
      onChange={(event) => onChange({ ...value, authMode: event.target.value as ClaudeHarnessConfiguration['authMode'] })} />
    <Select label="Sandbox" value={value.sandbox ?? ''} error={fieldMessage(issues, 'sandbox')}
      options={[{ value: '', label: 'Choose sandbox', disabled: true }, { value: 'read-only', label: 'Read only' }, { value: 'workspace-write', label: 'Workspace write' }, { value: 'danger-full-access', label: 'Full access' }]}
      onChange={(event) => onChange({ ...value, sandbox: event.target.value as ClaudeHarnessConfiguration['sandbox'] })} />
    <Checkbox label="Include Foreman Code MCP" checked={Boolean(value.mcpServers?.graphql)} disabled={!setup.data?.graphqlMcp}
      hint="Uses this app’s endpoint. Tool access is selected separately after saving."
      onChange={event => onChange({ ...value, mcpServers: event.target.checked && setup.data?.graphqlMcp ? { graphql: setup.data.graphqlMcp } : {} })} />
    {setup.isError ? <p role="alert">Could not read the app MCP endpoint. <Button size="sm" onClick={() => void setup.refetch()}>Retry</Button></p> : null}
    <p>Saving stores this preset. Check the saved profile in computer settings before execution. Authentication, tool policy and lifecycle evidence must match that exact profile.</p>
  </div>
}
