import type { PendingNativeInteraction } from '@graphql/contracts'
import { Fragment } from 'react'
import { summarizeApprovalRequest } from '../approvals/approvalPresentation'
import { approvalOptionScope } from '../../shared/ui/approvalOptionScope'
import { Button, Icon } from '../../shared/ui/nocturne'

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const string = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined

export function OperatorApprovalCard({ interaction, disabled, onSelect }: {
  interaction: PendingNativeInteraction
  disabled: boolean
  onSelect: (optionId: string) => void
}) {
  const request = object(interaction.request)
  const meta = object(request._meta)
  const params = object(meta.tool_params)
  const mcp = interaction.nativeRequestType === 'mcpServer/elicitation/request' && meta.codex_approval_kind === 'mcp_tool_call'
  const summary = summarizeApprovalRequest(interaction.request, interaction.nativeRequestType)
  const tool = string(meta.tool_title) ?? string(meta.tool_name)
  const connector = string(meta.connector_name) ?? string(request.serverName)
  const destination = string(meta.origin) ?? string(params.origin) ?? summary.target
  const options = interaction.responseOptions.filter((option) => !(mcp && option.semantic === 'cancel'))
  const once = options.filter((option) => option.semantic === 'approve_once' || option.semantic === 'allow_turn')
  const persistent = options.filter((option) => option.semantic === 'persistent_policy_change')
  const other = options.filter((option) => !once.includes(option) && !persistent.includes(option) && option.semantic !== 'reject')
  const decline = options.filter((option) => option.semantic === 'reject')
  const renderOption = (option: typeof options[number]) => <Button key={option.optionId} size="sm"
    variant={option.semantic === 'approve_once' || option.semantic === 'allow_turn' ? 'primary' : option.semantic === 'reject' ? 'ghost' : 'secondary'}
    disabled={disabled} onClick={() => onSelect(option.optionId)}
    title={approvalOptionScope(option)}>{mcp && option.semantic === 'approve_once' ? 'Allow once' : option.label}</Button>
  return <section className="operator-approval-card" aria-label="Operator approval request">
    <div className="operator-approval-heading"><span className="operator-approval-mark"><Icon name="lock" size={15} /></span><div>
      <h3>{mcp && tool ? `${tool}?` : summary.operation}</h3>
      <p>{mcp ? `MCP tool · ${connector ?? 'Provider'}` : interaction.nativeRequestType === 'item/commandExecution/requestApproval' ? 'Shell command' : interaction.nativeRequestType === 'item/fileChange/requestApproval' ? 'File change' : 'Operator request'}</p>
    </div></div>
    {destination ? <p className="operator-approval-target">{mcp ? 'Access' : 'Target'} <strong>{destination}</strong></p> : null}
    {summary.command ? <code className="operator-approval-command">{summary.command}</code> : null}
    {summary.explanation ? <p className="operator-approval-reason">{summary.explanation}</p> : null}
    <details className="operator-approval-disclosure"><summary><Icon name="info" size={14} /> Request details</summary>
      <dl>
        <dt>Execution</dt><dd>{mcp ? 'MCP tool call through the connected provider' : interaction.nativeRequestType === 'item/commandExecution/requestApproval' ? 'Shell command in the agent sandbox' : interaction.nativeRequestType === 'item/fileChange/requestApproval' ? 'File change in the agent sandbox' : interaction.nativeRequestType}</dd>
        {string(meta.tool_name) ? <><dt>Tool</dt><dd>{string(meta.tool_name)}</dd></> : null}
        {connector ? <><dt>Provider</dt><dd>{connector}</dd></> : null}
        {Object.keys(params).map((key) => <Fragment key={key}><dt>{key}</dt><dd>{typeof params[key] === 'string' ? String(params[key]) : JSON.stringify(params[key])}</dd></Fragment>)}
        {persistent.length ? <><dt>Always allow</dt><dd>Changes persistent native policy for future requests.</dd></> : null}
      </dl>
    </details>
    <div className="operator-approval-actions">{[...once, ...persistent, ...other].map(renderOption)}</div>
    {decline.length ? <div className="operator-approval-decline">{decline.map(renderOption)}</div> : null}
  </section>
}
