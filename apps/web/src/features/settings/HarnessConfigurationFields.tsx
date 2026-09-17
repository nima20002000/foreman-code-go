import { useEffect, useId, useRef, useState } from 'react'
import {
  DEFAULT_HARNESS_DEFAULTS, changeCodexSandbox, withAdvancedDefaults,
  type CodexAdvancedConfiguration, type HarnessConfiguration, type HarnessDefaults, type OpenCodeAdvancedConfiguration,
} from '@graphql/contracts'

import { Alert, Button, Checkbox, Select, Textarea, TextField } from '../../shared/ui/nocturne'
import { useHarnessDefaultsQuery, useManagedHarnessCatalogQuery } from '../../shared/api/query'
import { CODEX_MODELS, OPENCODE_MODELS } from '../agents/agentSettings'
import { useValidateHarnessConfiguration } from '../../shared/api/harnessValidation'
import { prepareHarnessEditor, resetHarnessEditor, switchHarnessEditor, type HarnessEditor } from './harnessEditor'
import { fieldMessage, focusFirstInvalid, validationIssues, type FieldIssue } from './fieldValidation'
import { McpDetectionSettings } from './McpDetectionSettings'
import './settingsUsability.css'

function PermissionRules({ value, onChange, issues }: {
  value: OpenCodeAdvancedConfiguration['permissionRules']
  onChange(value: OpenCodeAdvancedConfiguration['permissionRules']): void
  issues: readonly FieldIssue[]
}) {
  const prefix = useId()
  const [keys, setKeys] = useState<string[]>([])
  const [announcement, setAnnouncement] = useState('')
  const usedKeys = new Set(keys)
  const rowKeys = value.map((_, index) => {
    const existingKey = keys[index]
    if (existingKey) return existingKey
    let key = `${prefix}-${index}`
    while (usedKeys.has(key)) key += '-new'
    usedKeys.add(key)
    return key
  })
  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction
    if (target < 0 || target >= value.length) return
    const next = [...value]
    const nextKeys = [...rowKeys]
    ;[next[index], next[target]] = [next[target]!, next[index]!]
    ;[nextKeys[index], nextKeys[target]] = [nextKeys[target]!, nextKeys[index]!]
    setKeys(nextKeys)
    onChange(next)
    setAnnouncement(`Permission rule moved from ${index + 1} to ${target + 1}.`)
    window.requestAnimationFrame(() => document.getElementById(`${nextKeys[target]}-permission`)?.focus())
  }
  return <fieldset className="permission-rules"><legend>Ordered permission rules</legend>
    <p>For matching permissions and patterns, the last matching rule wins. Put broad rules first and specific exceptions afterward.</p>
    {value.length === 0 ? <p>Native default permission policy</p> : value.map((rule, index) => <div className="permission-rule-row" key={rowKeys[index]}>
      {(['permission', 'pattern', 'effect'] as const).map((key) => {
        const label = key === 'permission' ? 'Permission' : key === 'pattern' ? 'Pattern' : 'Effect'
        const id = `${rowKeys[index]}-${key}`
        const error = fieldMessage(issues, `advanced.permissionRules.${index}.${key}`)
        return key === 'effect'
          ? <Select key={key} id={id} label={label} aria-label={`${label} ${index + 1}`} error={error} value={rule.effect}
            options={[{ value: 'allow', label: 'Allow' }, { value: 'ask', label: 'Ask' }, { value: 'deny', label: 'Deny' }]}
            onChange={(event) => onChange(value.map((item, position) => position === index ? { ...item, effect: event.target.value as typeof rule.effect } : item))} />
          : <TextField key={key} id={id} label={label} aria-label={`${label} ${index + 1}`} error={error} value={rule[key]}
            onChange={(event) => onChange(value.map((item, position) => position === index ? { ...item, [key]: event.target.value } : item))} />
      })}
      <div className="permission-rule-actions">
        <Button size="sm" aria-label={`Move permission rule ${index + 1} up`} disabled={index === 0} onClick={() => move(index, -1)}>Move up</Button>
        <Button size="sm" aria-label={`Move permission rule ${index + 1} down`} disabled={index === value.length - 1} onClick={() => move(index, 1)}>Move down</Button>
        <Button size="sm" aria-label={`Remove permission rule ${index + 1}`} onClick={() => {
          setKeys(rowKeys.filter((_, position) => position !== index))
          onChange(value.filter((_, position) => position !== index))
        }}>Remove</Button>
      </div>
    </div>)}
    <Button size="sm" onClick={() => {
      setKeys([...rowKeys, crypto.randomUUID()])
      onChange([...value, { permission: 'shell', pattern: '*', effect: 'ask' }])
    }}>Add custom rule</Button>
    <small>Rules retain order and patterns exactly. Moving a rule changes its priority.</small>
    <p className="visually-hidden" role="status">{announcement}</p>
  </fieldset>
}

export function HarnessConfigurationFields({ editor, onChange, routedApproval = false, allowHarnessChange = true, compact = false, advancedOnly = false, workspaceId, harnessDefaults, issues: saveIssues = [] }: {
  editor: HarnessEditor
  onChange(editor: HarnessEditor): void
  routedApproval?: boolean
  allowHarnessChange?: boolean
  /** Keep the node editor focused on configuration, not the diagnostic dashboard. */
  compact?: boolean
  /** Show only the full advanced configuration surface inside a parent editor view. */
  advancedOnly?: boolean
  workspaceId?: string
  harnessDefaults?: HarnessDefaults
  issues?: readonly FieldIssue[]
}) {
  const value = withAdvancedDefaults(editor.configuration)
  const nativeCheck = useValidateHarnessConfiguration()
  const presetsQuery = useHarnessDefaultsQuery({ enabled: allowHarnessChange && !harnessDefaults })
  const presets = harnessDefaults ?? presetsQuery.data?.defaults
  const presetLabel = harnessDefaults ? 'provided preset' : 'saved provider preset'
  const snapshot = JSON.stringify([editor.configuration, editor.shellEnvironmentText, editor.mcpText])
  const [checkAttempt, setCheckAttempt] = useState<{ snapshot: string; message?: string; issues?: FieldIssue[] }>()
  const currentAttempt = checkAttempt?.snapshot === snapshot ? checkAttempt : undefined
  const issues = [...saveIssues, ...(currentAttempt?.issues ?? [])].map((issue) => {
    if (issue.path.join('.') === 'requiresResume') return { ...issue, path: ['advanced', 'sessionPersistence'] }
    if (issue.path.join('.') === 'autoApprove') return { ...issue, path: ['advanced', 'permissionHandling'] }
    if (issue.path.join('.') === 'advanced.workspaceWrite') return { ...issue, path: ['sandbox'] }
    return issue
  })
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => { if (checkAttempt?.snapshot === snapshot && checkAttempt.issues?.length) focusFirstInvalid(root.current) }, [checkAttempt, snapshot])
  let candidate: HarnessConfiguration | undefined
  try { candidate = prepareHarnessEditor(editor) } catch { /* Incomplete raw inputs are allowed until Check or Save. */ }
  const checked = candidate && nativeCheck.data && JSON.stringify(candidate) === JSON.stringify(nativeCheck.data.configuration)
    ? nativeCheck.data : undefined
  const checkingCurrent = nativeCheck.isPending && Boolean(currentAttempt)
  const failedCurrent = currentAttempt?.message ?? (currentAttempt && nativeCheck.isError ? nativeCheck.error.message : undefined)
  const catalog = useManagedHarnessCatalogQuery(import.meta.env.MODE !== 'test')
  const entry = catalog.data?.find((item) => item.harness === value.harness)
  const modelListId = useId()
  const validationId = useId()
  const fieldId = (path: string) => `${validationId}-${path}`
  const error = (path: string) => fieldMessage(issues, path)
  const change = (configuration: HarnessConfiguration) => onChange({ ...editor, configuration })
  const codex = (advanced: CodexAdvancedConfiguration) => {
    if (value.harness === 'codex') change({ ...value, advanced })
  }
  const opencode = (advanced: OpenCodeAdvancedConfiguration) => {
    if (value.harness === 'opencode') change({ ...value, autoApprove: advanced.permissionHandling === 'native_auto', advanced })
  }
  const catalogKnows = (setting: string) => !entry?.capability || entry.capability.supportedSettings.includes(setting)
  return <div className={`harness-configuration-fields${advancedOnly ? ' agent-settings-advanced-only' : ''}`} ref={root}>
    {allowHarnessChange ? <>
      <Select label="Harness" aria-label="Harness" id={fieldId('harness')} value={value.harness} hint="Each harness keeps a separate draft. Only the selected harness is applied or saved." onChange={(event) => {
        const next = event.target.value as 'codex' | 'opencode'
        onChange(switchHarnessEditor(editor, next, presets?.[next]))
      }}
        options={(['codex', 'opencode'] as const).map((harness) => ({ value: harness, label: harness === 'codex' ? 'Codex' : 'OpenCode', disabled: harness !== value.harness && !editor.drafts?.[harness] && !presets?.[harness] }))} />
      {!harnessDefaults && presetsQuery.isPending ? <p role="status">Loading saved provider presets…</p> : null}
      {!harnessDefaults && presetsQuery.isError ? <Alert live tone="danger" title="Saved provider presets could not be refreshed." action={<Button size="sm" onClick={() => void presetsQuery.refetch()}>Retry provider presets</Button>}>Existing drafts are preserved; built-in defaults will not be substituted.</Alert> : null}
      <div className="settings-preset-controls">
        <Button size="sm" disabled={!presets} onClick={() => { if (presets) onChange(resetHarnessEditor(editor, presets[value.harness])) }}>Discard this harness draft and load {presetLabel}</Button>
        <Button size="sm" onClick={() => onChange(resetHarnessEditor(editor, DEFAULT_HARNESS_DEFAULTS[value.harness]))}>Discard this harness draft and use built-in defaults</Button>
        <small>Saved provider presets and built-in defaults are different. Resetting affects only this harness draft.</small>
      </div>
    </> : null}
    <TextField label="Model" aria-label="Model" id={fieldId('model')} list={modelListId} value={value.model} disabled={!catalogKnows('model')} error={error('model')} onChange={(event) => change({ ...value, model: event.target.value })} />
    <datalist id={modelListId}>{(value.harness === 'codex' ? CODEX_MODELS : OPENCODE_MODELS).map((model) => <option key={model} value={model} />)}</datalist>
    {value.harness === 'codex' ? <>
      <Select label="Effort" aria-label="Effort" id={fieldId('reasoningEffort')} value={value.reasoningEffort} disabled={!catalogKnows('reasoningEffort')} error={error('reasoningEffort')}
        options={['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((effort) => ({ value: effort, label: effort }))}
        onChange={(event) => change({ ...value, reasoningEffort: event.target.value as typeof value.reasoningEffort })} />
      <Select label="Sandbox" aria-label="Sandbox" id={fieldId('sandbox')} value={value.sandbox} disabled={!catalogKnows('sandbox')} error={error('sandbox')} hint="Leaving workspace-write removes additional writable directories and workspace-write options."
        options={[{ value: 'read-only', label: 'Read only' }, { value: 'workspace-write', label: 'Workspace write' }, { value: 'danger-full-access', label: 'Danger: full access' }]}
        onChange={(event) => change(changeCodexSandbox(value, event.target.value as typeof value.sandbox))} />
      <Checkbox label="Fast mode" id={fieldId('serviceTier')} checked={value.serviceTier === 'priority'} disabled={!catalogKnows('serviceTier')} error={error('serviceTier')} onChange={(event) => change({ ...value, serviceTier: event.target.checked ? 'priority' : 'standard' })} />
    </> : <>
      <TextField label="Provider variant" aria-label="Provider variant" id={fieldId('variant')} value={value.variant} disabled={!catalogKnows('variant')} error={error('variant')} onChange={(event) => change({ ...value, variant: event.target.value })} />
      <TextField label="Native Agent" aria-label="Native Agent" id={fieldId('nativeAgent')} value={value.nativeAgent} disabled={!catalogKnows('nativeAgent')} error={error('nativeAgent')} onChange={(event) => change({ ...value, nativeAgent: event.target.value })} />
      <Checkbox label="Show thinking" checked={value.thinking} disabled={!catalogKnows('thinking')} onChange={(event) => change({ ...value, thinking: event.target.checked })} />
      <small>Thinking controls reasoning-block visibility, not the provider variant or reasoning effort.</small>
    </>}
    <div className="settings-readiness">
      <Alert live tone="info" title={checkingCurrent ? 'Checking this selection…' : checked ? 'Native check completed for this selection.' : 'Not checked. This selection has no current native qualification result.'} />
      {entry?.capability && !entry.capability.ready ? <Alert live tone="danger" title="The saved provider preset is not ready. Check this selection before using it." /> : null}
      {entry?.discoveryError ? <Alert live tone="danger" title={entry.discoveryError.message} /> : null}
      {failedCurrent ? <Alert live tone="danger" title={failedCurrent} /> : null}
      <Button disabled={nativeCheck.isPending} onClick={() => {
        nativeCheck.reset()
        try {
          const configuration = prepareHarnessEditor(editor)
          setCheckAttempt({ snapshot })
          nativeCheck.mutate(configuration)
        } catch (failure) {
          setCheckAttempt({ snapshot, message: failure instanceof Error ? failure.message : 'Review the configuration.', issues: validationIssues(failure) })
        }
      }}>{nativeCheck.isPending ? checkingCurrent ? 'Checking selected configuration…' : 'Checking previous selection…' : 'Check selected configuration'}</Button>
      {!compact ? <details><summary>Provider readiness and qualification details</summary>
        {entry?.capability ? <><strong>Provider {entry.capability.version}</strong><p>Native checks for the saved Harness template report: {entry.capability.ready ? 'ready' : 'not ready'}. This is not a qualification of these unsaved edits.</p><p>Qualified settings: {entry.capability.supportedSettings.join(', ')}.</p>{entry.capability.unsupportedCapabilities.length ? <p>Unsupported: {entry.capability.unsupportedCapabilities.join(', ')}.</p> : null}</> : <p>Provider qualification is unavailable. These edits are not yet qualified.</p>}
        <p>Models, provider variants and native Agents are validated on the server when defaults are saved. Advanced runner-specific policies require the matching native session transport and are checked when a new session starts.</p>
        {checked ? <p>Checked this exact selection against {checked.qualification.version} at {checked.checkedAt}. Native checks cover: {checked.qualification.supportedSettings.join(', ')}. Other Advanced settings still require session admission.</p> : null}
      </details> : <p>Full provider qualification details are available in Settings.</p>}
    </div>
    <details className="advanced-settings agent-settings-advanced" open={advancedOnly || undefined}><summary>Advanced</summary>
      <p className="settings-help">Changes apply to new sessions, not an already accepted run. Process settings may require a new provider process. Native MCP policies do not install servers, rewrite runner configuration, or bypass the sandbox.</p>
      {value.harness === 'codex' ? (() => {
        const advanced = value.advanced!
        const workspaceWrite = advanced.workspaceWrite ?? { networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
        return <div className="settings-field-grid">
          {advancedOnly ? <p className="agent-settings-section-label">Approval</p> : null}
          <Select label="Approval policy" aria-label="Approval policy" id={fieldId('advanced.approvalPolicy')} value={advanced.approvalPolicy} error={error('advanced.approvalPolicy')}
            options={[{ value: 'on-request', label: 'On request' }, { value: 'never', label: 'Never' }]}
            onChange={(event) => codex({ ...advanced, approvalPolicy: event.target.value as typeof advanced.approvalPolicy })} />
          <Select label="Approval reviewer" aria-label="Approval reviewer" id={fieldId('advanced.approvalsReviewer')} value={advanced.approvalsReviewer} error={error('advanced.approvalsReviewer')} hint={routedApproval ? 'Native AI review conflicts with this workflow’s routed approval authority.' : 'Native AI reviewer uses Codex’s own reviewer.'}
            options={[{ value: 'user', label: 'GraphQL routed' }, { value: 'auto_review', label: 'Native AI reviewer', disabled: routedApproval }]}
            onChange={(event) => codex({ ...advanced, approvalsReviewer: event.target.value as typeof advanced.approvalsReviewer })} />
          {advancedOnly ? <p className="agent-settings-section-label">Workspace access</p> : null}
          <Textarea label="Additional writable directories" aria-label="Additional writable directories" id={fieldId('advanced.additionalWritableDirectories')} rows={3} disabled={value.sandbox !== 'workspace-write'} value={advanced.additionalWritableDirectories.join('\n')} error={error('advanced.additionalWritableDirectories')} hint="One absolute path per line. Spaces are significant; blank lines are removed only on Save."
            onChange={(event) => codex({ ...advanced, additionalWritableDirectories: event.target.value.split('\n') })} />
          {(['networkAccess', 'excludeTmpdirEnvVar', 'excludeSlashTmp'] as const).map((key) => <Checkbox key={key} id={fieldId(`advanced.workspaceWrite.${key}`)} disabled={value.sandbox !== 'workspace-write'} checked={workspaceWrite[key]} error={error(`advanced.workspaceWrite.${key}`)}
            label={key === 'networkAccess' ? 'Workspace network access' : key === 'excludeTmpdirEnvVar' ? 'Exclude TMPDIR from writable roots' : 'Exclude /tmp from writable roots'}
            onChange={(event) => codex({ ...advanced, workspaceWrite: { ...workspaceWrite, [key]: event.target.checked } })} />)}
          {advancedOnly ? <p className="agent-settings-section-label">Session &amp; tools</p> : null}
          <Select label="Session" aria-label="Session persistence" id={fieldId('advanced.sessionPersistence')} value={advanced.sessionPersistence} error={error('advanced.sessionPersistence')} hint="Ephemeral sessions cannot support resume-dependent approval handling."
            options={[{ value: 'persistent', label: 'Persistent' }, { value: 'ephemeral', label: 'Ephemeral', disabled: routedApproval }]}
            onChange={(event) => codex({ ...advanced, sessionPersistence: event.target.value as typeof advanced.sessionPersistence })} />
          <Select label="Web search" aria-label="Web search" id={fieldId('advanced.webSearch')} value={advanced.webSearch} error={error('advanced.webSearch')}
            options={[{ value: 'disabled', label: 'Disabled' }, { value: 'cached', label: 'Cached' }, { value: 'live', label: 'Live' }]}
            onChange={(event) => codex({ ...advanced, webSearch: event.target.value as typeof advanced.webSearch })} />
          {advancedOnly ? <p className="agent-settings-section-label">Native configuration</p> : null}
          <Textarea label="Shell environment JSON" aria-label="Shell environment JSON" id={fieldId('advanced.shellEnvironment')} rows={6} value={editor.shellEnvironmentText} error={error('advanced.shellEnvironment')} hint="Fields: inherit (all/core/none), ignoreDefaultExcludes, filters (include/exclude), and set. Do not enter credentials."
            onChange={(event) => onChange({ ...editor, shellEnvironmentText: event.target.value })} />
        </div>
      })() : (() => {
        const advanced = value.advanced!
        return <div className="settings-field-grid">
          {advancedOnly ? <p className="agent-settings-section-label">Review permissions</p> : null}
          <Select label="Permission handling" aria-label="Permission handling" id={fieldId('advanced.permissionHandling')} value={advanced.permissionHandling} error={error('advanced.permissionHandling')} hint="Native auto is not a reviewer Agent and cannot be used by this routed managed transport. Select routed review to repair a legacy native-auto configuration."
            options={[{ value: 'graphql_routed', label: 'GraphQL routed review' }, { value: 'native_auto', label: 'Native auto approve (unsupported by the managed server)', disabled: true }]}
            onChange={(event) => opencode({ ...advanced, permissionHandling: event.target.value as typeof advanced.permissionHandling })} />
          <PermissionRules value={advanced.permissionRules} issues={issues} onChange={(permissionRules) => opencode({ ...advanced, permissionRules })} />
          {advancedOnly ? <p className="agent-settings-section-label">Runtime</p> : null}
          <Select label="Plugin loading" aria-label="Plugin loading" id={fieldId('advanced.plugins')} value={advanced.plugins.mode} error={error('advanced.plugins')} hint="Requires a new provider process."
            options={[{ value: 'inherit', label: 'Inherit' }, { value: 'pure', label: 'Pure' }]}
            onChange={(event) => opencode({ ...advanced, plugins: { mode: event.target.value as 'inherit' | 'pure' } })} />
          <TextField label="Subagent depth" aria-label="Subagent depth" id={fieldId('advanced.subagentDepth')} type="number" min={0} step={1} value={Number.isNaN(advanced.subagentDepth) ? '' : advanced.subagentDepth ?? ''} error={error('advanced.subagentDepth')} hint="Enter a whole number of 0 or more, or leave blank."
            onChange={(event) => opencode({ ...advanced, subagentDepth: event.target.value === '' ? undefined : event.target.valueAsNumber })} />
          {(['auto', 'prune'] as const).map((key) => <Checkbox key={key} checked={advanced.compaction[key]} label={key === 'auto' ? 'Automatic compaction' : 'Prune compacted messages'}
            onChange={(event) => opencode({ ...advanced, compaction: { ...advanced.compaction, [key]: event.target.checked } })} />)}
          {(['reservedTokens', 'tailTurns', 'preserveRecentTokens'] as const).map((key) => <TextField key={key} label={key} aria-label={key} id={fieldId(`advanced.compaction.${key}`)} type="number" min={0} step={1} value={Number.isNaN(advanced.compaction[key]) ? '' : advanced.compaction[key] ?? ''} error={error(`advanced.compaction.${key}`)} hint="Enter a whole number of 0 or more, or leave blank."
            onChange={(event) => opencode({ ...advanced, compaction: { ...advanced.compaction, [key]: event.target.value === '' ? undefined : event.target.valueAsNumber } })} />)}
          <p>Configuration loading: native. Session/process overrides do not rewrite project files.</p>
        </div>
      })()}
      {advancedOnly ? <p className="agent-settings-section-label">MCP policy</p> : null}
      <Textarea label="Native MCP controls JSON" aria-label="Native MCP controls JSON" id={fieldId(value.harness === 'codex' ? 'advanced.mcpServers' : 'advanced.mcp')} rows={7} value={editor.mcpText} error={error(value.harness === 'codex' ? 'advanced.mcpServers' : 'advanced.mcp')}
        onChange={(event) => onChange({ ...editor, mcpText: event.target.value })} />
      <small>{value.harness === 'codex' ? 'Map server names to enabled, required, enabledTools, disabledTools, defaultToolsApprovalMode and per-tool policies. The native runner must match the accepted policy.' : 'Map already configured server names to true (enabled) or false (disabled). Requires a new session; this does not install an MCP server.'}</small>
    </details>
    {compact ? <p className="settings-help">Full runner-scoped App MCP diagnostics are available in Settings. Checking this selection does not change permissions or qualify an existing session.</p> : workspaceId ? <McpDetectionSettings workspaceId={workspaceId} /> : <details className="settings-help"><summary>Runner-scoped App MCP evidence</summary><p>Select a real workspace below to inspect runner-scoped App MCP evidence.</p></details>}
  </div>
}
