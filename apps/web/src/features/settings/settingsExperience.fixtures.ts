import { DEFAULT_HARNESS_DEFAULTS } from '@graphql/contracts'
export function nativeOptionsFixture(harness: 'codex' | 'opencode') {
  const value = DEFAULT_HARNESS_DEFAULTS[harness]
  return { data: { harness, models: [{ id: value.model, name: value.model, reasoningEfforts: ['low', 'medium', 'high'], variants: [''], serviceTiers: ['standard','priority'] }], nativeAgents: ['build','plan'] },
    isSuccess: true, isPending: false, isFetching: false, isError: false, error: null }
}
