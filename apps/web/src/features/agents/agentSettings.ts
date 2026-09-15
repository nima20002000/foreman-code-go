import {
  DEFAULT_HARNESS_DEFAULTS,
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

export function modelOptions(harness: NonNullable<Agent['harness']>): readonly string[] {
  return harness === 'codex' ? CODEX_MODELS : OPENCODE_MODELS
}

export function initialModel(agent: Agent, harness: NonNullable<Agent['harness']>): string {
  const options = modelOptions(harness)
  return agent.model && options.includes(agent.model) ? agent.model : options[0]!
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

export function configuredHarness(
  agent: Agent,
  harness: NonNullable<Agent['harness']>,
  model: string,
  effort: NonNullable<Agent['effort']>,
  fastMode: boolean,
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
    return {
      ...opencode,
      model,
      variant: effort === 'low' || effort === 'high' || effort === 'max' ? effort : 'max',
    }
  }
  const codex = current.harness === 'codex' ? current : DEFAULT_HARNESS_DEFAULTS.codex
  return {
    ...codex,
    model,
    reasoningEffort: effort,
    serviceTier: fastMode ? 'priority' : 'standard',
  }
}

export function defaultAgentForHarness(
  harness: NonNullable<Agent['harness']>,
  id: string,
  name: string,
  configuration: HarnessConfiguration = DEFAULT_HARNESS_DEFAULTS[harness],
): Agent {
  const exact = configuration.harness === harness
    ? configuration
    : DEFAULT_HARNESS_DEFAULTS[harness]
  return {
    id,
    name,
    role: 'Agent',
    harness,
    model: exact.model,
    effort: exact.harness === 'codex' ? exact.reasoningEffort : exact.variant,
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
