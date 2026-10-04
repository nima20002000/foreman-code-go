import type { HarnessOptions } from '@foreman-code/contracts/management'
import { DomainError } from '../errors.js'

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function strings(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0))] : []
}
function bounded(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value) || value.length > 10_000) throw new DomainError('HARNESS_CATALOG_INVALID', `${name} is not a bounded native catalog.`, 502)
  return value
}

export function codexModelOptions(value: unknown): HarnessOptions['models'] {
  return bounded(object(value).models, 'models').filter(item => object(item).visibility !== 'hide').map((item) => {
    const model = object(item)
    if (typeof model.slug !== 'string' || !model.slug) throw new DomainError('HARNESS_CATALOG_INVALID', 'A native model has no ID.', 502)
    return {
      id: model.slug,
      ...(typeof model.display_name === 'string' ? { name: model.display_name } : {}),
      reasoningEfforts: strings(bounded(model.supported_reasoning_levels ?? [], 'reasoning levels').map((level) => object(level).effort)),
      variants: [], serviceTiers: ['standard', ...(strings(model.additional_speed_tiers).includes('fast') ? ['priority'] : [])],
      ...(typeof model.priority === 'number' && Number.isFinite(model.priority) ? { defaultPriority: model.priority } : {}),
    }
  })
}

/** Return selectable public metadata only, never provider credentials/configuration. */
export function openCodeOptions(value: unknown, agentsValue: unknown): Pick<HarnessOptions, 'authenticated' | 'models' | 'nativeAgents'> {
  const catalog = object(value)
  const providers = bounded(catalog.all, 'providers')
  if (!Array.isArray(catalog.connected) || !catalog.connected.every((item) => typeof item === 'string')) {
    throw new DomainError('HARNESS_AUTH_STATE_UNKNOWN', 'The native provider did not report connected provider IDs.', 502)
  }
  const connected = new Set(strings(catalog.connected))
  const models: HarnessOptions['models'] = []
  for (const providerValue of providers) {
    const provider = object(providerValue)
    if (typeof provider.id !== 'string' || !connected.has(provider.id)) continue
    for (const [id, modelValue] of Object.entries(object(provider.models))) {
      if (models.length >= 10_000) throw new DomainError('HARNESS_CATALOG_INVALID', 'The native model catalog exceeds its limit.', 502)
      const model = object(modelValue)
      if (model.status === 'deprecated' || model.status === 'disabled') continue
      const outputModalities = strings(object(model.modalities).output)
      if (outputModalities.length && !outputModalities.includes('text')) continue
      models.push({ id: `${provider.id}/${id}`, providerId: provider.id,
        ...(typeof model.name === 'string' ? {name: model.name} : {}),
        reasoningEfforts: [], variants: ['', ...Object.keys(object(model.variants))], serviceTiers: [],
        ...(typeof model.release_date === 'string' && Number.isFinite(Date.parse(model.release_date)) ? { releasedAt: model.release_date } : {}),
        ...(object(catalog.default)[provider.id] === id ? { defaultPriority: 0 } : {}),
      })
    }
  }
  const nativeAgents = strings(bounded(agentsValue, 'native agents').filter((item) => object(item).hidden !== true)
    .map((item) => object(item).name))
  return { authenticated: connected.size > 0, models, nativeAgents }
}

export function harnessSettingSupport(harness: 'codex' | 'opencode'): HarnessOptions['settings'] {
  if (harness === 'codex') return [
    {field: 'model', support: 'conditional', detail: 'Choose a model from this native catalog.'},
    {field: 'reasoningEffort', support: 'conditional', detail: 'Must be advertised by the selected model.'},
    {field: 'serviceTier', support: 'conditional', detail: 'Priority requires the native Fast tier.'},
    {field: 'sandbox', support: 'supported', detail: 'read-only, workspace-write, or explicit danger-full-access; no implicit elevation.'},
    {field: 'advanced.approvalPolicy', support: 'supported', detail: 'on-request or never.'},
    {field: 'advanced.approvalsReviewer', support: 'conditional', detail: 'Native auto_review cannot replace Foreman Code-routed workflow approvals.'},
    {field: 'advanced.additionalWritableDirectories', support: 'conditional', detail: 'Only with an explicitly selected workspace-write sandbox.'},
    {field: 'advanced.workspaceWrite', support: 'conditional', detail: 'Only with an explicitly selected workspace-write sandbox.'},
    {field: 'advanced.sessionPersistence', support: 'conditional', detail: 'Resume-dependent workflows require persistent sessions.'},
    {field: 'advanced.shellEnvironment', support: 'supported', detail: 'Passed as the accepted native shell environment policy.'},
    {field: 'advanced.webSearch', support: 'supported', detail: 'disabled, cached, or live.'},
    {field: 'advanced.mcpServers', support: 'conditional', detail: 'Policies must match installed native entries; this does not provision credentials or connections.'},
  ]
  return [
    {field: 'model', support: 'conditional', detail: 'Choose a model from a connected native provider.'},
    {field: 'variant', support: 'conditional', detail: 'Use an advertised named variant; an empty string selects the native default.'},
    {field: 'nativeAgent', support: 'conditional', detail: 'Choose a discovered native Agent; it is not an application authority role.'},
    {field: 'thinking', support: 'metadata_only', detail: 'The native server path does not consume this presentation flag. Use a supported named variant for model behavior.'},
    {field: 'autoApprove', support: 'conditional', detail: 'Must remain false for managed routed approval.'},
    {field: 'advanced.permissionRules', support: 'supported', detail: 'Ordered native permission rules; questions remain unsupported.'},
    {field: 'advanced.permissionHandling', support: 'conditional', detail: 'Must be graphql_routed.'},
    {field: 'advanced.subagentDepth', support: 'supported', detail: 'Passed as native subagent_depth; not a workflow-wide budget.'},
    {field: 'advanced.plugins.mode', support: 'supported', detail: 'inherit or explicit pure mode.'},
    {field: 'advanced.compaction', support: 'supported', detail: 'Passed to native compaction configuration.'},
    {field: 'advanced.configLoading.mode', support: 'conditional', detail: 'Only native configuration loading is supported.'},
    {field: 'advanced.mcp.serverEnabled', support: 'conditional', detail: 'Switches preconfigured native servers; does not install new connections.'},
  ]
}
