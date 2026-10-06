import { expect, it } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import type { HarnessOptions } from '@foreman-code/contracts/management'
import { codexModelOptions, openCodeOptions } from '../src/modules/harnesses/operatorOptions.js'
import { latestNativeModel, nativeModelDefaults } from '../src/modules/harnesses/modelDefaults.js'

const catalog = (harness: HarnessOptions['harness'], models: HarnessOptions['models']): HarnessOptions => ({ harness,
  providerVersion: 'observed', authenticated: true, models, nativeAgents: ['build'], settings: [], restrictions: [], checkedAt: new Date().toISOString() })
const model = (id: string, rest: Partial<HarnessOptions['models'][number]> = {}): HarnessOptions['models'][number] => ({
  id, reasoningEfforts: ['low', 'medium', 'high'], variants: ['', 'medium', 'max'], serviceTiers: ['standard'], ...rest })

it('uses native preference when IDs do not establish recency and excludes hidden Codex helpers', () => {
  const models = codexModelOptions({ models: [{ slug: 'older-z', priority: 9, supported_reasoning_levels: [{ effort: 'high' }, { effort: 'medium' }] },
    { slug: 'newer-a', priority: 1, supported_reasoning_levels: [{ effort: 'medium' }] }, { slug: 'hidden-helper', priority: 0, visibility: 'hide', supported_reasoning_levels: [] }] })
  expect(latestNativeModel(catalog('codex', models)).id).toBe('newer-a')
  expect(nativeModelDefaults(DEFAULT_HARNESS_DEFAULTS.codex, catalog('codex', models))).toMatchObject({
    model: 'newer-a', reasoningEffort: 'medium', sandbox: DEFAULT_HARNESS_DEFAULTS.codex.sandbox })
})

it('selects the latest connected OpenCode release and medium variant from its observed metadata', () => {
  const options = openCodeOptions({ all: [{ id: 'connected', models: {
    'older-z': { release_date: '2026-06-01', variants: { max: {} } }, 'newer-a': { release_date: '2026-09-30', variants: { medium: {}, high: {} } },
    retired: { release_date: '2026-10-01', status: 'deprecated' },
    imageOnly: { release_date: '2026-10-02', modalities: { output: ['image'] } },
  } }, { id: 'unconnected', models: { latest: { release_date: '2026-10-02' } } }], connected: ['connected'] }, [{ name: 'build' }])
  const value = nativeModelDefaults(DEFAULT_HARNESS_DEFAULTS.opencode, { ...catalog('opencode', options.models), authenticated: options.authenticated })
  expect(value).toMatchObject({ model: 'connected/newer-a', variant: 'medium', autoApprove: false })
})

it('defaults OpenCode to its newest OpenCode Go model even when another connected provider released later', () => {
  const options = openCodeOptions({ all: [
    { id: 'other-provider', models: { newest: { release_date: '2026-10-05' } } },
    { id: 'opencode-go', models: { 'deepseek-v4-flash': { release_date: '2026-07-31' }, older: { release_date: '2026-01-01' } } },
  ], connected: ['other-provider', 'opencode-go'] }, [{ name: 'build' }])
  expect(nativeModelDefaults(DEFAULT_HARNESS_DEFAULTS.opencode, { ...catalog('opencode', options.models), authenticated: options.authenticated }))
    .toMatchObject({ model: 'opencode-go/deepseek-v4-flash' })
})

it('does not invent model ordering or effort support', () => {
  expect(() => latestNativeModel(catalog('codex', [model('newer-looking-id')]))).toThrow('no release date or default model preference')
  const options = catalog('opencode', [model('connected/model', { defaultPriority: 0, variants: ['', 'high'] })])
  expect(nativeModelDefaults(DEFAULT_HARNESS_DEFAULTS.opencode, options).variant).toBe('')
})

it('selects advertised medium Claude effort while preserving its profile and sandbox', () => {
  const configuration = { harness: 'claude' as const, model: 'placeholder', configDirectory: '/actual/profile', authMode: 'subscription' as const,
    permissionMode: 'default' as const, sandbox: 'danger-full-access' as const, tools: [], permissionRules: [], instructions: '', mcpServers: {} }
  expect(nativeModelDefaults(configuration, catalog('claude', [model('actual-canonical-model', { defaultPriority: -1 })]))).toEqual({
    ...configuration, model: 'actual-canonical-model', effort: 'medium' })
  expect(nativeModelDefaults({ ...configuration, effort: 'max' as const }, catalog('claude', [model('no-effort-model', {
    defaultPriority: -1, reasoningEfforts: [],
  })])).effort).toBeUndefined()
})
