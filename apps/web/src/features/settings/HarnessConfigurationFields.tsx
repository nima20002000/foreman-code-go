import { useEffect, useRef, useState } from 'react'
import {
  DEFAULT_HARNESS_DEFAULTS, changeCodexSandbox, withAdvancedDefaults,
  type CodexAdvancedConfiguration, type HarnessConfiguration, type HarnessDefaults, type OpenCodeAdvancedConfiguration,
} from '@graphql/contracts'
import { Alert, Button, Card, CardBody, CardFooter, Checkbox, Select, TextField } from '../../shared/ui/nocturne'
import { useHarnessDefaultsQuery } from '../../shared/api/query'
import { useAutomaticHarnessCheck, useRefreshNativeHarness } from '../../shared/api/harnessSettings'
import { prepareHarnessEditor, resetHarnessEditor, switchHarnessEditor, type HarnessEditor } from './harnessEditor'
import { fieldMessage, focusFirstInvalid, type FieldIssue } from './fieldValidation'
import { HarnessBasicFields, HarnessFooterOptions } from './HarnessBasicFields'
import { HarnessDirectoryPicker } from './HarnessDirectoryPicker'
import { HarnessMcpManager } from './HarnessMcpManager'
import { HarnessMcpPolicies } from './HarnessMcpPolicies'
import { HarnessPermissionRules } from './HarnessPermissionRules'
import { McpDetectionSettings } from './McpDetectionSettings'
import './harnessWorkbench.css'

export function HarnessConfigurationFields({ editor, onChange, routedApproval = false, allowHarnessChange = true,
  compact = false, advancedOnly = false, workspaceId, harnessDefaults, issues = [],
}: {
  editor: HarnessEditor; onChange(editor: HarnessEditor): void; routedApproval?: boolean; allowHarnessChange?: boolean;
  compact?: boolean; advancedOnly?: boolean; workspaceId?: string; harnessDefaults?: HarnessDefaults; issues?: readonly FieldIssue[];
}) {
  const value = withAdvancedDefaults(editor.configuration)
  const [advanced, setAdvanced] = useState(advancedOnly)
  const [section, setSection] = useState<'permissions' | 'context' | 'mcp'>('permissions')
  const root = useRef<HTMLDivElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const presetsQuery = useHarnessDefaultsQuery({ enabled: allowHarnessChange && !harnessDefaults })
  const presets = harnessDefaults ?? presetsQuery.data?.defaults
  const refresh = useRefreshNativeHarness(value.harness)
  let candidate: HarnessConfiguration | undefined
  try { candidate = prepareHarnessEditor(editor) } catch { /* Save displays field validation; incomplete inputs aren't checked. */ }
  const check = useAutomaticHarnessCheck(candidate)
  const error = (path: string) => fieldMessage(issues, path)
  const change = (configuration: HarnessConfiguration) => onChange({ ...editor, configuration })
  const codex = (settings: CodexAdvancedConfiguration) => {
    if (value.harness === 'codex') change({ ...value, advanced: settings })
  }
  const opencode = (settings: OpenCodeAdvancedConfiguration) => {
    if (value.harness === 'opencode') change({ ...value, autoApprove: settings.permissionHandling === 'native_auto', advanced: settings })
  }
  const goAdvanced = (next: boolean) => {
    setAdvanced(next)
    requestAnimationFrame(() => next ? heading.current?.focus() : toggle.current?.focus())
  }
  const issuePath = issues[0]?.path.join('.') ?? ''
  useEffect(() => {
    if (!issuePath) return
    if (issuePath.startsWith('advanced.') || issuePath === 'requiresResume' || issuePath === 'autoApprove') {
      setAdvanced(true)
      setSection(/mcp/i.test(issuePath) ? 'mcp' : /sessionPersistence|requiresResume|webSearch|compaction|subagentDepth|plugins/.test(issuePath) ? 'context' : 'permissions')
    }
    const frame = requestAnimationFrame(() => focusFirstInvalid(root.current))
    return () => cancelAnimationFrame(frame)
  }, [issuePath])
  const showAdvanced = advanced || advancedOnly
  const status = check.current && check.result.isFetching ? 'Checking…'
    : check.current && check.result.isSuccess ? 'Ready' : ''
  return <div className={`harness-workbench${compact ? ' harness-workbench--compact' : ''}`} ref={root}
    role="group" aria-label={value.harness === 'codex' ? 'Codex' : 'OpenCode'}>
    {allowHarnessChange ? <>
      <Select label="Harness" value={value.harness} options={(['codex', 'opencode'] as const).map((harness) => ({
        value: harness, label: harness === 'codex' ? 'Codex' : 'OpenCode',
        disabled: harness !== value.harness && !editor.drafts?.[harness] && !presets?.[harness],
      }))} onChange={(event) => {
        const next = event.target.value as 'codex' | 'opencode'
        onChange(switchHarnessEditor(editor, next, presets?.[next]))
      }} />
      {!harnessDefaults && presetsQuery.isPending ? <p role="status">Loading saved provider presets…</p> : null}
      {!harnessDefaults && presetsQuery.isError ? <Alert live tone="danger" title="Saved provider presets could not be refreshed."
        action={<Button size="sm" onClick={() => void presetsQuery.refetch()}>Retry provider presets</Button>}>Existing drafts are preserved; built-in defaults will not be substituted.</Alert> : null}
      <div className="settings-preset-controls">
        <Button size="sm" disabled={!presets} onClick={() => { if (presets) onChange(resetHarnessEditor(editor, presets[value.harness])) }}>Reset to saved</Button>
        <Button size="sm" onClick={() => onChange(resetHarnessEditor(editor, DEFAULT_HARNESS_DEFAULTS[value.harness]))}>Discard this harness draft and use built-in defaults</Button>
      </div>
    </> : null}
    <Card className="harness-config-card">
      <header className="harness-card-heading">
        <div className="harness-inline-actions">{showAdvanced && !advancedOnly ? <Button size="sm" variant="ghost" aria-label="Back to harness settings" onClick={() => goAdvanced(false)}>← Back</Button> : null}
          <h3 tabIndex={-1} ref={heading}>{`${value.harness === 'codex' ? 'Codex' : 'OpenCode'}${showAdvanced ? ' · Advanced' : ''}`}</h3></div>
        <span className={`harness-status${status === 'Ready' ? ' harness-success' : ''}`} role="status">{status}</span>
      </header>
      <CardBody>
        {!showAdvanced ? <HarnessBasicFields value={value} issues={issues} onChange={change} /> : <div className="harness-advanced-page">
          <nav className="harness-section-nav" aria-label="Advanced sections">
            {(['permissions', 'context', 'mcp'] as const).map((tab) => <Button key={tab} size="sm" variant={section === tab ? 'secondary' : 'ghost'} aria-pressed={section === tab}
              onClick={() => setSection(tab)}>{tab === 'permissions' ? 'Permissions' : tab === 'context' ? 'Session' : 'MCP & tools'}</Button>)}
          </nav>
          <div className="harness-advanced-content" key={`${value.harness}-${section}`}>
            {value.harness === 'codex' && section === 'permissions' ? <>
              <div className="harness-two-columns">
                <Select label="Approval policy" value={value.advanced!.approvalPolicy} error={error('advanced.approvalPolicy')}
                  options={[{ value: 'on-request', label: 'Ask when needed' }, { value: 'never', label: 'Never request escalation' }]}
                  onChange={(event) => codex({ ...value.advanced!, approvalPolicy: event.target.value as CodexAdvancedConfiguration['approvalPolicy'] })} />
                <Select label="Approval reviewer" value={value.advanced!.approvalsReviewer} error={error('advanced.approvalsReviewer')}
                  options={[{ value: 'user', label: 'User / app routing' }, { value: 'auto_review', label: 'Codex automatic review', disabled: routedApproval }]}
                  hint={routedApproval ? 'This workflow uses app approval routing.' : undefined}
                  onChange={(event) => codex({ ...value.advanced!, approvalsReviewer: event.target.value as CodexAdvancedConfiguration['approvalsReviewer'] })} />
              </div>
              {value.sandbox === 'workspace-write' ? <>
                <HarnessDirectoryPicker value={value.advanced!.additionalWritableDirectories} error={error('advanced.additionalWritableDirectories')}
                  onChange={(directories) => codex({ ...value.advanced!, additionalWritableDirectories: directories })} />
                <div className="harness-switch-list">{([
                  ['networkAccess', 'Workspace network access'],
                  ['excludeTmpdirEnvVar', 'Exclude TMPDIR from writable roots'],
                  ['excludeSlashTmp', 'Exclude /tmp from writable roots'],
                ] as const).map(([key, label]) => <Checkbox key={key} label={label} checked={value.advanced!.workspaceWrite?.[key] ?? false}
                  error={error(`advanced.workspaceWrite.${key}`)} onChange={(event) => codex({ ...value.advanced!, workspaceWrite: {
                    networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false,
                    ...value.advanced!.workspaceWrite, [key]: event.target.checked,
                  } })} />)}</div>
              </> : <div className="harness-empty"><span>Leaving workspace-write removes additional writable directories and workspace-write options.</span><Button size="sm" onClick={() => change(changeCodexSandbox(value, 'workspace-write'))}>Use Workspace write</Button></div>}
            </> : null}
            {value.harness === 'codex' && section === 'context' ? <div className="harness-two-columns">
              <Select label="Web search" value={value.advanced!.webSearch} error={error('advanced.webSearch')}
                options={[{ value: 'disabled', label: 'Disabled' }, { value: 'cached', label: 'Cached' }, { value: 'live', label: 'Live' }]}
                onChange={(event) => codex({ ...value.advanced!, webSearch: event.target.value as CodexAdvancedConfiguration['webSearch'] })} />
              <Select label="Session history" value={value.advanced!.sessionPersistence} error={error('advanced.sessionPersistence') ?? error('requiresResume')}
                options={[{ value: 'persistent', label: 'Keep history · supports recovery' }, { value: 'ephemeral', label: 'Ephemeral · no resume', disabled: routedApproval }]}
                onChange={(event) => codex({ ...value.advanced!, sessionPersistence: event.target.value as CodexAdvancedConfiguration['sessionPersistence'] })} />
            </div> : null}
            {value.harness === 'opencode' && section === 'permissions' ? <>
              <Select label="Permission handling" value={value.advanced!.permissionHandling} error={error('advanced.permissionHandling') ?? error('autoApprove')}
                options={[{ value: 'graphql_routed', label: 'App approval routing' }, { value: 'native_auto', label: 'Native auto approve · unavailable in managed sessions', disabled: value.advanced!.permissionHandling !== 'native_auto' }]}
                onChange={(event) => opencode({ ...value.advanced!, permissionHandling: event.target.value as OpenCodeAdvancedConfiguration['permissionHandling'] })} />
              <HarnessPermissionRules value={value.advanced!.permissionRules} issues={issues} onChange={(permissionRules) => opencode({ ...value.advanced!, permissionRules })} />
            </> : null}
            {value.harness === 'opencode' && section === 'context' ? <>
              <div className="harness-two-columns">
                <Select label="Plugins" value={value.advanced!.plugins.mode} options={[{ value: 'inherit', label: 'Use configured plugins' }, { value: 'pure', label: 'Pure mode · no plugins' }]}
                  onChange={(event) => opencode({ ...value.advanced!, plugins: { mode: event.target.value as 'inherit' | 'pure' } })} />
                <TextField label="Subagent depth" type="number" min={0} step={1} value={value.advanced!.subagentDepth ?? ''} placeholder="Native default" error={error('advanced.subagentDepth')}
                  onChange={(event) => opencode({ ...value.advanced!, subagentDepth: event.target.value === '' ? undefined : Number(event.target.value) })} />
              </div>
              <div className="harness-switch-list"><Checkbox label="Automatic compaction" checked={value.advanced!.compaction.auto}
                onChange={(event) => opencode({ ...value.advanced!, compaction: { ...value.advanced!.compaction, auto: event.target.checked } })} />
                <Checkbox label="Prune old tool output" checked={value.advanced!.compaction.prune}
                  onChange={(event) => opencode({ ...value.advanced!, compaction: { ...value.advanced!.compaction, prune: event.target.checked } })} /></div>
              <div className="harness-two-columns">{([
                ['reservedTokens', 'Reserved tokens'], ['tailTurns', 'Recent turns to keep'], ['preserveRecentTokens', 'Recent tokens to keep'],
              ] as const).map(([key, label]) => <TextField key={key} label={label} type="number" min={0} step={1} placeholder="Native default"
                value={value.advanced!.compaction[key] ?? ''} error={error(`advanced.compaction.${key}`)}
                onChange={(event) => opencode({ ...value.advanced!, compaction: { ...value.advanced!.compaction, [key]: event.target.value === '' ? undefined : Number(event.target.value) } })} />)}</div>
            </> : null}
            {section === 'mcp' ? <>
              {!compact ? <HarnessMcpManager key={value.harness} harness={value.harness} /> : null}
              <HarnessMcpPolicies key={`policies-${value.harness}`} editor={editor} onChange={onChange} />
              {!compact ? <McpDetectionSettings workspaceId={workspaceId} harness={value.harness} /> : null}
            </> : null}
          </div>
        </div>}
        {check.current && check.result.isError ? <Alert live tone="danger" title={check.result.error.message} /> : null}
        {refresh.isError ? <Alert live tone="danger" title={refresh.error.message} /> : null}
        {issues.length ? <p className="n-field-error" role="alert">{issues.map((issue) => issue.message).filter((message, index, values) => values.indexOf(message) === index).join(' ')}</p> : null}
      </CardBody>
      <CardFooter>
        <div className="harness-card-footer">
          <div className="harness-inline-actions">{!showAdvanced ? <Button ref={toggle} size="sm" variant="ghost" onClick={() => goAdvanced(true)}>Advanced</Button> : null}
            {!compact ? <Button size="sm" variant="ghost" aria-label="Check selected configuration" disabled={refresh.isPending} onClick={() => refresh.mutate()}>{refresh.isPending ? 'Checking…' : 'Refresh checks'}</Button> : null}
            {presets?.[value.harness] ? <Button size="sm" variant="ghost" onClick={() => onChange(resetHarnessEditor(editor, presets[value.harness]))}>Reset to saved</Button> : null}
          </div>
          {!showAdvanced ? <HarnessFooterOptions value={value} issues={issues} onChange={change} /> : null}
        </div>
      </CardFooter>
    </Card>
  </div>
}
