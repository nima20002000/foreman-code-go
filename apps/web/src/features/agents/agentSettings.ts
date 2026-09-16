import {
  DEFAULT_HARNESS_DEFAULTS,
  AgentEffortSchema,
  HarnessConfigurationSchema,
  projectHarnessEffort,
  type Agent,
  type HarnessConfiguration,
  type HarnessDefaults,
} from '@graphql/contracts'

export const CODEX_MODELS: readonly string[] = [
  'gpt-5.6-luna',
  'gpt-5.6-terra',
  'gpt-5.6-sol',
  'gpt-6-astra',
]

export const OPENCODE_MODELS: readonly string[] = ['opencode-go/deepseek-v4.1-flash']

export const STANDARD_EFFORTS: readonly NonNullable<Agent['effort']>[] = [
  'low', 'medium', 'high', 'xhigh', 'max',
]

export function modelOptions(harness: NonNullable<Agent['harness']>, current?: string): readonly string[] {
  const known = harness === 'codex' ? CODEX_MODELS : OPENCODE_MODELS
  return current && !known.includes(current) ? [...known, current] : known
}

export function initialModel(agent: Agent, harness: NonNullable<Agent['harness']>): string {
  const exact = agent.harnessConfiguration
  return (exact?.harness === harness ? exact.model : agent.model) ?? modelOptions(harness)[0]!
}

export function initialEffort(agent: Agent, harness: NonNullable<Agent['harness']>): string {
  const exact = agent.harnessConfiguration
  if (exact?.harness === harness) return exact.harness === 'opencode' ? exact.variant : exact.reasoningEffort
  return agent.effort ?? (harness === 'opencode' ? 'max' : 'medium')
}

export function effortOptions(
  harness: NonNullable<Agent['harness']>,
  model: string,
): readonly NonNullable<Agent['effort']>[] {
  if (harness === 'opencode') return ['low', 'high', 'max']
  return model === 'gpt-6-astra' ? [...STANDARD_EFFORTS, 'ultra'] : STANDARD_EFFORTS
}

export const effortLabels: Record<NonNullable<Agent['effort']>, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
}

export function exactEffortOptions(harness: NonNullable<Agent['harness']>, model: string, current: string): readonly string[] {
  const known: readonly string[] = effortOptions(harness, model)
  return known.includes(current) ? known : [...known, current]
}

export function effortOptionLabel(value: string): string {
  const legacy = AgentEffortSchema.safeParse(value)
  return legacy.success ? effortLabels[legacy.data] : `${value} (provider variant)`
}

export function dropsWorkspaceWriteSettings(configuration: HarnessConfiguration | undefined, sandbox: string): boolean {
  return configuration?.harness === 'codex' && sandbox !== 'workspace-write'
    && Boolean(configuration.advanced && (configuration.advanced.workspaceWrite
      || configuration.advanced.additionalWritableDirectories.length > 0))
}

export function configuredHarness(
  agent: Agent,
  harness: NonNullable<Agent['harness']>,
  model: string,
  effort: string,
  fastMode: boolean,
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access',
  creationDefaults?: HarnessDefaults,
): HarnessConfiguration {
  // New agents use the selected global template; existing agents keep their
  // copied settings and must not inherit later global-default changes.
  const current = creationDefaults?.[harness]
    ?? (agent.harnessConfiguration?.harness === harness
      ? agent.harnessConfiguration
      : DEFAULT_HARNESS_DEFAULTS[harness])
  if (harness === 'opencode') {
    const opencode = current.harness === 'opencode' ? current : DEFAULT_HARNESS_DEFAULTS.opencode
    return HarnessConfigurationSchema.parse({ ...opencode, model, variant: effort })
  }
  const codex = current.harness === 'codex' ? current : DEFAULT_HARNESS_DEFAULTS.codex
  const advanced = codex.advanced ? structuredClone(codex.advanced) : undefined
  if (advanced && sandbox !== 'workspace-write') {
    delete advanced.workspaceWrite
    advanced.additionalWritableDirectories = []
  }
  return HarnessConfigurationSchema.parse({
    ...codex,
    ...(advanced ? { advanced } : {}),
    model,
    reasoningEffort: AgentEffortSchema.parse(effort),
    sandbox,
    serviceTier: fastMode ? 'priority' : 'standard',
  })
}

export function defaultAgentForHarness(
  harness: NonNullable<Agent['harness']>,
  id: string,
  name: string,
  configuration: HarnessConfiguration = DEFAULT_HARNESS_DEFAULTS[harness],
): Agent {
  const exact = structuredClone(configuration.harness === harness
    ? configuration
    : DEFAULT_HARNESS_DEFAULTS[harness])
  const legacyEffort = projectHarnessEffort(exact)
  return {
    id,
    name,
    role: 'Agent',
    harness,
    model: exact.model,
    effort: legacyEffort,
    ...(exact.harness === 'codex' ? { fastMode: exact.serviceTier === 'priority' } : {}),
    harnessConfiguration: exact,
  }
}

export function nextHarnessAgentName(
  harness: NonNullable<Agent['harness']>,
  agents: readonly Agent[],
): string {
  const prefix = harness === 'codex' ? 'codex' : 'opencode'
  const pattern = new RegExp(`^${prefix}-(\\d{3,})$`, 'i')
  const highest = agents.reduce((current, agent) => {
    const match = pattern.exec(agent.name.trim())
    return match ? Math.max(current, Number(match[1])) : current
  }, 0)
  return `${prefix}-${String(highest + 1).padStart(3, '0')}`
}
