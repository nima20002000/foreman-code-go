import { useId, useState } from 'react'
import {
  DEFAULT_HARNESS_DEFAULTS, changeCodexSandbox, withAdvancedDefaults,
  type CodexAdvancedConfiguration, type HarnessConfiguration, type HarnessDefaults, type OpenCodeAdvancedConfiguration,
} from '@graphql/contracts'

import { useManagedHarnessCatalogQuery } from '../../shared/api/query'
import { CODEX_MODELS, OPENCODE_MODELS } from '../agents/agentSettings'
import { useValidateHarnessConfiguration } from '../../shared/api/harnessValidation'
import { createHarnessEditor, prepareHarnessEditor, type HarnessEditor } from './harnessEditor'
import { McpDetectionSettings } from './McpDetectionSettings'

function PermissionRules({ value, onChange }: {
  value: OpenCodeAdvancedConfiguration['permissionRules']
  onChange(value: OpenCodeAdvancedConfiguration['permissionRules']): void
}) {
  const prefix = useId()
  const [keys, setKeys] = useState<string[]>([])
  const usedKeys = new Set(keys)
  const rowKeys = value.map((_, index) => {
    const existingKey = keys[index]
    if (existingKey) return existingKey
    let key = `${prefix}-${index}`
    while (usedKeys.has(key)) key += '-new'
    usedKeys.add(key)
    return key
  })
  return <fieldset className="permission-rules"><legend>Ordered permission rules</legend>
    {value.length === 0 ? <p>Native default permission policy</p> : value.map((rule, index) => <div key={rowKeys[index]}>
      <input aria-label={`Permission ${index + 1}`} value={rule.permission} onChange={(event) => onChange(value.map((item, position) => position === index ? { ...item, permission: event.target.value } : item))} />
      <input aria-label={`Pattern ${index + 1}`} value={rule.pattern} onChange={(event) => onChange(value.map((item, position) => position === index ? { ...item, pattern: event.target.value } : item))} />
      <select aria-label={`Effect ${index + 1}`} value={rule.effect} onChange={(event) => onChange(value.map((item, position) => position === index ? { ...item, effect: event.target.value as typeof rule.effect } : item))}>
        <option value="allow">Allow</option><option value="ask">Ask</option><option value="deny">Deny</option>
      </select>
      <button type="button" aria-label={`Remove permission rule ${index + 1}`} onClick={() => {
        setKeys(rowKeys.filter((_, position) => position !== index))
        onChange(value.filter((_, position) => position !== index))
      }}>Remove</button>
    </div>)}
    <button type="button" onClick={() => {
      setKeys([...rowKeys, crypto.randomUUID()])
      onChange([...value, { permission: 'shell', pattern: '*', effect: 'ask' }])
    }}>Add custom rule</button>
    <small>Rules retain order and patterns exactly. Row identities are editor-only.</small>
  </fieldset>
}

export function HarnessConfigurationFields({ editor, onChange, routedApproval = false, allowHarnessChange = true, workspaceId, harnessDefaults = DEFAULT_HARNESS_DEFAULTS }: {
  editor: HarnessEditor
  onChange(editor: HarnessEditor): void
  routedApproval?: boolean
  allowHarnessChange?: boolean
  workspaceId?: string
  harnessDefaults?: HarnessDefaults
}) {
  const value = withAdvancedDefaults(editor.configuration)
  const nativeCheck = useValidateHarnessConfiguration()
  const [checkError, setCheckError] = useState<string>()
  let candidate: HarnessConfiguration | undefined
  try { candidate = prepareHarnessEditor(editor) } catch { /* Incomplete raw inputs are allowed until Check or Save. */ }
  const checked = candidate && nativeCheck.data && JSON.stringify(candidate) === JSON.stringify(nativeCheck.data.configuration)
    ? nativeCheck.data : undefined
  const catalog = useManagedHarnessCatalogQuery(import.meta.env.MODE !== 'test')
  const entry = catalog.data?.find((item) => item.harness === value.harness)
  const modelListId = useId()
  const change = (configuration: HarnessConfiguration) => onChange({ ...editor, configuration })
  const codex = (advanced: CodexAdvancedConfiguration) => {
    if (value.harness === 'codex') change({ ...value, advanced })
  }
  const opencode = (advanced: OpenCodeAdvancedConfiguration) => {
    if (value.harness === 'opencode') change({ ...value, autoApprove: advanced.permissionHandling === 'native_auto', advanced })
  }
  const catalogKnows = (setting: string) => !entry?.capability || entry.capability.supportedSettings.includes(setting)
  return <>
    {allowHarnessChange ? <label>Harness<select aria-label="Harness" value={value.harness} onChange={(event) => onChange(createHarnessEditor(harnessDefaults[event.target.value as 'codex' | 'opencode']))}>
      <option value="codex">Codex</option><option value="opencode">OpenCode</option>
    </select></label> : null}
    <label>Model<input aria-label="Model" list={modelListId} value={value.model} disabled={!catalogKnows('model')} onChange={(event) => change({ ...value, model: event.target.value })} /></label>
    <datalist id={modelListId}>{(value.harness === 'codex' ? CODEX_MODELS : OPENCODE_MODELS).map((model) => <option key={model} value={model} />)}</datalist>
    <div className="settings-help" role="status">
      {entry?.capability ? <><strong>Provider {entry.capability.version}</strong><p>Native checks for the saved Harness template report: {entry.capability.ready ? 'ready' : 'not ready'}. This is not a qualification of these unsaved edits.</p><p>Qualified settings: {entry.capability.supportedSettings.join(', ')}.</p>{entry.capability.unsupportedCapabilities.length ? <p>Unsupported: {entry.capability.unsupportedCapabilities.join(', ')}.</p> : null}</> : <p>Provider qualification is unavailable. These edits are not yet qualified.</p>}
      {entry?.discoveryError ? <p>{entry.discoveryError.message}</p> : null}
      <p>Models, provider variants and native Agents are validated on the server when defaults are saved. Advanced runner-specific policies require the matching native session transport and are checked when a new session starts.</p>
      <button type="button" disabled={nativeCheck.isPending} onClick={() => {
        try { const configuration = prepareHarnessEditor(editor); setCheckError(undefined); nativeCheck.mutate(configuration) }
        catch (error) { setCheckError(error instanceof Error ? error.message : 'Review the configuration.') }
      }}>{nativeCheck.isPending ? 'Checking selected configuration…' : 'Check selected configuration'}</button>
      {checked ? <p>Checked this exact selection against {checked.qualification.version} at {checked.checkedAt}. Native checks cover: {checked.qualification.supportedSettings.join(', ')}. Other Advanced settings still require session admission.</p> : <p>The edited selection has no current native qualification result.</p>}
      {checkError || nativeCheck.isError ? <p role="alert">{checkError ?? nativeCheck.error?.message}</p> : null}
    </div>
    {value.harness === 'codex' ? <>
      <label>Reasoning effort<select aria-label="Effort" value={value.reasoningEffort} disabled={!catalogKnows('reasoningEffort')} onChange={(event) => change({ ...value, reasoningEffort: event.target.value as typeof value.reasoningEffort })}>
        {['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((effort) => <option key={effort} value={effort}>{effort}</option>)}
      </select></label>
      <label>Sandbox<select aria-label="Sandbox" value={value.sandbox} disabled={!catalogKnows('sandbox')} onChange={(event) => change(changeCodexSandbox(value, event.target.value as typeof value.sandbox))}>
        <option value="read-only">Read only</option><option value="workspace-write">Workspace write</option><option value="danger-full-access">Danger: full access</option>
      </select><small>Leaving workspace-write removes additional writable directories and workspace-write options.</small></label>
      <label className="settings-switch"><input type="checkbox" checked={value.serviceTier === 'priority'} disabled={!catalogKnows('serviceTier')} onChange={(event) => change({ ...value, serviceTier: event.target.checked ? 'priority' : 'standard' })} />Fast mode</label>
    </> : <>
      <label>Provider variant<input aria-label="Provider variant" value={value.variant} disabled={!catalogKnows('variant')} onChange={(event) => change({ ...value, variant: event.target.value })} /></label>
      <label>Native Agent<input aria-label="Native Agent" value={value.nativeAgent} disabled={!catalogKnows('nativeAgent')} onChange={(event) => change({ ...value, nativeAgent: event.target.value })} /></label>
      <label className="settings-switch"><input type="checkbox" checked={value.thinking} disabled={!catalogKnows('thinking')} onChange={(event) => change({ ...value, thinking: event.target.checked })} />Show thinking</label>
      <small>Thinking controls reasoning-block visibility, not the provider variant or reasoning effort.</small>
    </>}
    <details className="advanced-settings agent-settings-advanced"><summary>Advanced</summary>
      <p className="settings-help">Changes apply to new sessions, not an already accepted run. Process settings may require a new provider process. Native MCP policies do not install servers, rewrite runner configuration, or bypass the sandbox.</p>
      {value.harness === 'codex' ? (() => {
        const advanced = value.advanced!
        const workspaceWrite = advanced.workspaceWrite ?? { networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
        return <div className="settings-field-grid">
          <label>Approval policy<select aria-label="Approval policy" value={advanced.approvalPolicy} onChange={(event) => codex({ ...advanced, approvalPolicy: event.target.value as typeof advanced.approvalPolicy })}><option value="on-request">On request</option><option value="never">Never</option></select></label>
          <label>Approval reviewer<select aria-label="Approval reviewer" value={advanced.approvalsReviewer} onChange={(event) => codex({ ...advanced, approvalsReviewer: event.target.value as typeof advanced.approvalsReviewer })}><option value="user">GraphQL routed</option><option value="auto_review" disabled={routedApproval}>Native AI reviewer</option></select><small>{routedApproval ? 'Native AI review conflicts with this workflow’s routed approval authority.' : 'Native AI reviewer uses Codex’s own reviewer.'}</small></label>
          <label>Additional writable directories<textarea aria-label="Additional writable directories" rows={3} disabled={value.sandbox !== 'workspace-write'} value={advanced.additionalWritableDirectories.join('\n')} onChange={(event) => codex({ ...advanced, additionalWritableDirectories: event.target.value.split('\n') })} /><small>One absolute path per line. Spaces are significant; blank lines are removed only on Save.</small></label>
          {(['networkAccess', 'excludeTmpdirEnvVar', 'excludeSlashTmp'] as const).map((key) => <label className="settings-switch" key={key}><input type="checkbox" disabled={value.sandbox !== 'workspace-write'} checked={workspaceWrite[key]} onChange={(event) => codex({ ...advanced, workspaceWrite: { ...workspaceWrite, [key]: event.target.checked } })} />{key === 'networkAccess' ? 'Workspace network access' : key === 'excludeTmpdirEnvVar' ? 'Exclude TMPDIR from writable roots' : 'Exclude /tmp from writable roots'}</label>)}
          <label>Session<select aria-label="Session persistence" value={advanced.sessionPersistence} onChange={(event) => codex({ ...advanced, sessionPersistence: event.target.value as typeof advanced.sessionPersistence })}><option value="persistent">Persistent</option><option value="ephemeral" disabled={routedApproval}>Ephemeral</option></select><small>Ephemeral sessions cannot support resume-dependent approval handling.</small></label>
          <label>Web search<select aria-label="Web search" value={advanced.webSearch} onChange={(event) => codex({ ...advanced, webSearch: event.target.value as typeof advanced.webSearch })}><option value="disabled">Disabled</option><option value="cached">Cached</option><option value="live">Live</option></select></label>
          <label>Shell environment JSON<textarea aria-label="Shell environment JSON" rows={6} value={editor.shellEnvironmentText} onChange={(event) => onChange({ ...editor, shellEnvironmentText: event.target.value })} /><small>Fields: inherit (all/core/none), ignoreDefaultExcludes, filters (include/exclude), and set. Do not enter credentials.</small></label>
        </div>
      })() : (() => {
        const advanced = value.advanced!
        return <div className="settings-field-grid">
          <label>Permission handling<select aria-label="Permission handling" value={advanced.permissionHandling} onChange={(event) => opencode({ ...advanced, permissionHandling: event.target.value as typeof advanced.permissionHandling })}><option value="graphql_routed">GraphQL routed review</option><option value="native_auto" disabled>Native auto approve (unsupported by the managed server)</option></select><small>Native auto is not a reviewer Agent and cannot be used by this routed managed transport. Select routed review to repair a legacy native-auto configuration.</small></label>
          <PermissionRules value={advanced.permissionRules} onChange={(permissionRules) => opencode({ ...advanced, permissionRules })} />
          <label>Plugin loading<select aria-label="Plugin loading" value={advanced.plugins.mode} onChange={(event) => opencode({ ...advanced, plugins: { mode: event.target.value as 'inherit' | 'pure' } })}><option value="inherit">Inherit</option><option value="pure">Pure</option></select><small>Requires a new provider process.</small></label>
          <label>Subagent depth<input aria-label="Subagent depth" type="number" min={0} step={1} value={advanced.subagentDepth ?? ''} onChange={(event) => opencode({ ...advanced, subagentDepth: event.target.value === '' ? undefined : event.target.valueAsNumber })} /></label>
          {(['auto', 'prune'] as const).map((key) => <label className="settings-switch" key={key}><input type="checkbox" checked={advanced.compaction[key]} onChange={(event) => opencode({ ...advanced, compaction: { ...advanced.compaction, [key]: event.target.checked } })} />{key === 'auto' ? 'Automatic compaction' : 'Prune compacted messages'}</label>)}
          {(['reservedTokens', 'tailTurns', 'preserveRecentTokens'] as const).map((key) => <label key={key}>{key}<input aria-label={key} type="number" min={0} step={1} value={advanced.compaction[key] ?? ''} onChange={(event) => opencode({ ...advanced, compaction: { ...advanced.compaction, [key]: event.target.value === '' ? undefined : event.target.valueAsNumber } })} /></label>)}
          <p>Configuration loading: native. Session/process overrides do not rewrite project files.</p>
        </div>
      })()}
      <label>Native MCP controls JSON<textarea aria-label="Native MCP controls JSON" rows={7} value={editor.mcpText} onChange={(event) => onChange({ ...editor, mcpText: event.target.value })} /><small>{value.harness === 'codex' ? 'Map server names to enabled, required, enabledTools, disabledTools, defaultToolsApprovalMode and per-tool policies. The native runner must match the accepted policy.' : 'Map already configured server names to true (enabled) or false (disabled). Requires a new session; this does not install an MCP server.'}</small></label>
    </details>
    {workspaceId ? <McpDetectionSettings workspaceId={workspaceId} /> : <p className="settings-help">Select a real workspace below to inspect runner-scoped App MCP evidence.</p>}
  </>
}
