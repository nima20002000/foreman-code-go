import { useEffect, useId, useRef, useState } from 'react'
import {
  DEFAULT_HARNESS_DEFAULTS, changeCodexSandbox, withAdvancedDefaults,
  type CodexAdvancedConfiguration, type HarnessConfiguration, type HarnessDefaults, type OpenCodeAdvancedConfiguration,
} from '@graphql/contracts'

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
        return <label key={key} htmlFor={id}>{label}
          {key === 'effect' ? <select id={id} aria-label={`${label} ${index + 1}`} aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-error` : undefined} value={rule.effect} onChange={(event) => onChange(value.map((item, position) => position === index ? { ...item, effect: event.target.value as typeof rule.effect } : item))}>
            <option value="allow">Allow</option><option value="ask">Ask</option><option value="deny">Deny</option>
          </select> : <input id={id} aria-label={`${label} ${index + 1}`} aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-error` : undefined} value={rule[key]} onChange={(event) => onChange(value.map((item, position) => position === index ? { ...item, [key]: event.target.value } : item))} />}
          {error ? <small className="settings-field-error" id={`${id}-error`}>{error}</small> : null}
        </label>
      })}
      <div className="permission-rule-actions">
        <button type="button" aria-label={`Move permission rule ${index + 1} up`} disabled={index === 0} onClick={() => move(index, -1)}>Move up</button>
        <button type="button" aria-label={`Move permission rule ${index + 1} down`} disabled={index === value.length - 1} onClick={() => move(index, 1)}>Move down</button>
        <button type="button" aria-label={`Remove permission rule ${index + 1}`} onClick={() => {
          setKeys(rowKeys.filter((_, position) => position !== index))
          onChange(value.filter((_, position) => position !== index))
        }}>Remove</button>
      </div>
    </div>)}
    <button type="button" onClick={() => {
      setKeys([...rowKeys, crypto.randomUUID()])
      onChange([...value, { permission: 'shell', pattern: '*', effect: 'ask' }])
    }}>Add custom rule</button>
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
  const field = (path: string) => ({ id: `${validationId}-${path}`, 'aria-invalid': fieldMessage(issues, path) ? true as const : undefined,
    'aria-describedby': fieldMessage(issues, path) ? `${validationId}-${path}-error` : undefined })
  const error = (path: string) => {
    const message = fieldMessage(issues, path)
    return message ? <small className="settings-field-error" id={`${validationId}-${path}-error`}>{message}</small> : null
  }
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
      <label>Harness<select aria-label="Harness" value={value.harness} onChange={(event) => {
        const next = event.target.value as 'codex' | 'opencode'
        onChange(switchHarnessEditor(editor, next, presets?.[next]))
      }}>
        {(['codex', 'opencode'] as const).map((harness) => <option key={harness} value={harness} disabled={harness !== value.harness && !editor.drafts?.[harness] && !presets?.[harness]}>{harness === 'codex' ? 'Codex' : 'OpenCode'}</option>)}
      </select><small>Each harness keeps a separate draft. Only the selected harness is applied or saved.</small></label>
      {!harnessDefaults && presetsQuery.isPending ? <p role="status">Loading saved provider presets…</p> : null}
      {!harnessDefaults && presetsQuery.isError ? <p role="alert">Saved provider presets could not be refreshed. Existing drafts are preserved; built-in defaults will not be substituted.<button type="button" onClick={() => void presetsQuery.refetch()}>Retry provider presets</button></p> : null}
      <div className="settings-preset-controls">
        <button type="button" disabled={!presets} onClick={() => { if (presets) onChange(resetHarnessEditor(editor, presets[value.harness])) }}>Discard this harness draft and load {presetLabel}</button>
        <button type="button" onClick={() => onChange(resetHarnessEditor(editor, DEFAULT_HARNESS_DEFAULTS[value.harness]))}>Discard this harness draft and use built-in defaults</button>
        <small>Saved provider presets and built-in defaults are different. Resetting affects only this harness draft.</small>
      </div>
    </> : null}
    <label>Model<input {...field('model')} aria-label="Model" list={modelListId} value={value.model} disabled={!catalogKnows('model')} onChange={(event) => change({ ...value, model: event.target.value })} />{error('model')}</label>
    <datalist id={modelListId}>{(value.harness === 'codex' ? CODEX_MODELS : OPENCODE_MODELS).map((model) => <option key={model} value={model} />)}</datalist>
    {value.harness === 'codex' ? <>
      <label>Reasoning effort<select {...field('reasoningEffort')} aria-label="Effort" value={value.reasoningEffort} disabled={!catalogKnows('reasoningEffort')} onChange={(event) => change({ ...value, reasoningEffort: event.target.value as typeof value.reasoningEffort })}>
        {['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((effort) => <option key={effort} value={effort}>{effort}</option>)}
      </select>{error('reasoningEffort')}</label>
      <label>Sandbox<select {...field('sandbox')} aria-label="Sandbox" value={value.sandbox} disabled={!catalogKnows('sandbox')} onChange={(event) => change(changeCodexSandbox(value, event.target.value as typeof value.sandbox))}>
        <option value="read-only">Read only</option><option value="workspace-write">Workspace write</option><option value="danger-full-access">Danger: full access</option>
      </select><small>Leaving workspace-write removes additional writable directories and workspace-write options.</small>{error('sandbox')}</label>
      <label className="settings-switch"><input {...field('serviceTier')} type="checkbox" checked={value.serviceTier === 'priority'} disabled={!catalogKnows('serviceTier')} onChange={(event) => change({ ...value, serviceTier: event.target.checked ? 'priority' : 'standard' })} />Fast mode{error('serviceTier')}</label>
    </> : <>
      <label>Provider variant<input {...field('variant')} aria-label="Provider variant" value={value.variant} disabled={!catalogKnows('variant')} onChange={(event) => change({ ...value, variant: event.target.value })} />{error('variant')}</label>
      <label>Native Agent<input {...field('nativeAgent')} aria-label="Native Agent" value={value.nativeAgent} disabled={!catalogKnows('nativeAgent')} onChange={(event) => change({ ...value, nativeAgent: event.target.value })} />{error('nativeAgent')}</label>
      <label className="settings-switch"><input type="checkbox" checked={value.thinking} disabled={!catalogKnows('thinking')} onChange={(event) => change({ ...value, thinking: event.target.checked })} />Show thinking</label>
      <small>Thinking controls reasoning-block visibility, not the provider variant or reasoning effort.</small>
    </>}
    <div className="settings-readiness">
      <p role="status">{checkingCurrent ? 'Checking this selection…' : checked ? 'Native check completed for this selection.' : 'Not checked. This selection has no current native qualification result.'}</p>
      {entry?.capability && !entry.capability.ready ? <p role="alert">The saved provider preset is not ready. Check this selection before using it.</p> : null}
      {entry?.discoveryError ? <p role="alert">{entry.discoveryError.message}</p> : null}
      {failedCurrent ? <p role="alert">{failedCurrent}</p> : null}
      <button type="button" disabled={nativeCheck.isPending} onClick={() => {
        nativeCheck.reset()
        try {
          const configuration = prepareHarnessEditor(editor)
          setCheckAttempt({ snapshot })
          nativeCheck.mutate(configuration)
        } catch (failure) {
          setCheckAttempt({ snapshot, message: failure instanceof Error ? failure.message : 'Review the configuration.', issues: validationIssues(failure) })
        }
      }}>{nativeCheck.isPending ? checkingCurrent ? 'Checking selected configuration…' : 'Checking previous selection…' : 'Check selected configuration'}</button>
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
          <label>Approval policy<select {...field('advanced.approvalPolicy')} aria-label="Approval policy" value={advanced.approvalPolicy} onChange={(event) => codex({ ...advanced, approvalPolicy: event.target.value as typeof advanced.approvalPolicy })}><option value="on-request">On request</option><option value="never">Never</option></select>{error('advanced.approvalPolicy')}</label>
          <label>Approval reviewer<select {...field('advanced.approvalsReviewer')} aria-label="Approval reviewer" value={advanced.approvalsReviewer} onChange={(event) => codex({ ...advanced, approvalsReviewer: event.target.value as typeof advanced.approvalsReviewer })}><option value="user">GraphQL routed</option><option value="auto_review" disabled={routedApproval}>Native AI reviewer</option></select><small>{routedApproval ? 'Native AI review conflicts with this workflow’s routed approval authority.' : 'Native AI reviewer uses Codex’s own reviewer.'}</small>{error('advanced.approvalsReviewer')}</label>
          {advancedOnly ? <p className="agent-settings-section-label">Workspace access</p> : null}
          <label>Additional writable directories<textarea {...field('advanced.additionalWritableDirectories')} aria-label="Additional writable directories" rows={3} disabled={value.sandbox !== 'workspace-write'} value={advanced.additionalWritableDirectories.join('\n')} onChange={(event) => codex({ ...advanced, additionalWritableDirectories: event.target.value.split('\n') })} /><small>One absolute path per line. Spaces are significant; blank lines are removed only on Save.</small>{error('advanced.additionalWritableDirectories')}</label>
          {(['networkAccess', 'excludeTmpdirEnvVar', 'excludeSlashTmp'] as const).map((key) => <label className="settings-switch" key={key}><input {...field(`advanced.workspaceWrite.${key}`)} type="checkbox" disabled={value.sandbox !== 'workspace-write'} checked={workspaceWrite[key]} onChange={(event) => codex({ ...advanced, workspaceWrite: { ...workspaceWrite, [key]: event.target.checked } })} />{key === 'networkAccess' ? 'Workspace network access' : key === 'excludeTmpdirEnvVar' ? 'Exclude TMPDIR from writable roots' : 'Exclude /tmp from writable roots'}{error(`advanced.workspaceWrite.${key}`)}</label>)}
          {advancedOnly ? <p className="agent-settings-section-label">Session &amp; tools</p> : null}
          <label>Session<select {...field('advanced.sessionPersistence')} aria-label="Session persistence" value={advanced.sessionPersistence} onChange={(event) => codex({ ...advanced, sessionPersistence: event.target.value as typeof advanced.sessionPersistence })}><option value="persistent">Persistent</option><option value="ephemeral" disabled={routedApproval}>Ephemeral</option></select><small>Ephemeral sessions cannot support resume-dependent approval handling.</small>{error('advanced.sessionPersistence')}</label>
          <label>Web search<select {...field('advanced.webSearch')} aria-label="Web search" value={advanced.webSearch} onChange={(event) => codex({ ...advanced, webSearch: event.target.value as typeof advanced.webSearch })}><option value="disabled">Disabled</option><option value="cached">Cached</option><option value="live">Live</option></select>{error('advanced.webSearch')}</label>
          {advancedOnly ? <p className="agent-settings-section-label">Native configuration</p> : null}
          <label>Shell environment JSON<textarea {...field('advanced.shellEnvironment')} aria-label="Shell environment JSON" rows={6} value={editor.shellEnvironmentText} onChange={(event) => onChange({ ...editor, shellEnvironmentText: event.target.value })} /><small>Fields: inherit (all/core/none), ignoreDefaultExcludes, filters (include/exclude), and set. Do not enter credentials.</small>{error('advanced.shellEnvironment')}</label>
        </div>
      })() : (() => {
        const advanced = value.advanced!
        return <div className="settings-field-grid">
          {advancedOnly ? <p className="agent-settings-section-label">Review permissions</p> : null}
          <label>Permission handling<select {...field('advanced.permissionHandling')} aria-label="Permission handling" value={advanced.permissionHandling} onChange={(event) => opencode({ ...advanced, permissionHandling: event.target.value as typeof advanced.permissionHandling })}><option value="graphql_routed">GraphQL routed review</option><option value="native_auto" disabled>Native auto approve (unsupported by the managed server)</option></select><small>Native auto is not a reviewer Agent and cannot be used by this routed managed transport. Select routed review to repair a legacy native-auto configuration.</small>{error('advanced.permissionHandling')}</label>
          <PermissionRules value={advanced.permissionRules} issues={issues} onChange={(permissionRules) => opencode({ ...advanced, permissionRules })} />
          {advancedOnly ? <p className="agent-settings-section-label">Runtime</p> : null}
          <label>Plugin loading<select {...field('advanced.plugins')} aria-label="Plugin loading" value={advanced.plugins.mode} onChange={(event) => opencode({ ...advanced, plugins: { mode: event.target.value as 'inherit' | 'pure' } })}><option value="inherit">Inherit</option><option value="pure">Pure</option></select><small>Requires a new provider process.</small>{error('advanced.plugins')}</label>
          <label>Subagent depth<input {...field('advanced.subagentDepth')} aria-label="Subagent depth" type="number" min={0} step={1} value={Number.isNaN(advanced.subagentDepth) ? '' : advanced.subagentDepth ?? ''} onChange={(event) => opencode({ ...advanced, subagentDepth: event.target.value === '' ? undefined : event.target.valueAsNumber })} /><small>Enter a whole number of 0 or more, or leave blank.</small>{error('advanced.subagentDepth')}</label>
          {(['auto', 'prune'] as const).map((key) => <label className="settings-switch" key={key}><input type="checkbox" checked={advanced.compaction[key]} onChange={(event) => opencode({ ...advanced, compaction: { ...advanced.compaction, [key]: event.target.checked } })} />{key === 'auto' ? 'Automatic compaction' : 'Prune compacted messages'}</label>)}
          {(['reservedTokens', 'tailTurns', 'preserveRecentTokens'] as const).map((key) => <label key={key}>{key}<input {...field(`advanced.compaction.${key}`)} aria-label={key} type="number" min={0} step={1} value={Number.isNaN(advanced.compaction[key]) ? '' : advanced.compaction[key] ?? ''} onChange={(event) => opencode({ ...advanced, compaction: { ...advanced.compaction, [key]: event.target.value === '' ? undefined : event.target.valueAsNumber } })} /><small>Enter a whole number of 0 or more, or leave blank.</small>{error(`advanced.compaction.${key}`)}</label>)}
          <p>Configuration loading: native. Session/process overrides do not rewrite project files.</p>
        </div>
      })()}
      {advancedOnly ? <p className="agent-settings-section-label">MCP policy</p> : null}
      <label>Native MCP controls JSON<textarea {...field(value.harness === 'codex' ? 'advanced.mcpServers' : 'advanced.mcp')} aria-label="Native MCP controls JSON" rows={7} value={editor.mcpText} onChange={(event) => onChange({ ...editor, mcpText: event.target.value })} /><small>{value.harness === 'codex' ? 'Map server names to enabled, required, enabledTools, disabledTools, defaultToolsApprovalMode and per-tool policies. The native runner must match the accepted policy.' : 'Map already configured server names to true (enabled) or false (disabled). Requires a new session; this does not install an MCP server.'}</small>{error(value.harness === 'codex' ? 'advanced.mcpServers' : 'advanced.mcp')}</label>
    </details>
    {compact ? <p className="settings-help">Full runner-scoped App MCP diagnostics are available in Settings. Checking this selection does not change permissions or qualify an existing session.</p> : workspaceId ? <McpDetectionSettings workspaceId={workspaceId} /> : <details className="settings-help"><summary>Runner-scoped App MCP evidence</summary><p>Select a real workspace below to inspect runner-scoped App MCP evidence.</p></details>}
  </div>
}
