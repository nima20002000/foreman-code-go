import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
export function nativeOptionsFixture(harness: 'codex' | 'claude') {
  const value = harness === 'codex' ? DEFAULT_HARNESS_DEFAULTS.codex : { model: 'claude-sonnet' }
  return { data: { harness, models: [{ id: value.model, name: value.model, reasoningEfforts: ['low', 'medium', 'high'], variants: [''], serviceTiers: ['standard','priority'] }], nativeAgents: [] },
    isSuccess: true, isPending: false, isFetching: false, isError: false, error: null }
}
