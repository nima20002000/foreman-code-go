import { describe, expect, it } from 'vitest'
import { ProviderAccountApiKeyInputSchema } from './providerAccounts.js'
import { applyOperatorChatSettings, DEFAULT_HARNESS_DEFAULTS, operatorChatSettings } from './index.js'
import { ClaudeHarnessConfigurationSchema } from './claude.js'

const input = { commandId: 'account-key-command', expectedRevision: 1 }
const apiKey = 'sk-test-provider-account-key'

describe('provider account API key validation', () => {
  it('accepts a key and trims surrounding whitespace', () => {
    expect(ProviderAccountApiKeyInputSchema.parse({ ...input, apiKey: ` ${apiKey}\n` }))
      .toEqual({ ...input, apiKey })
  })

  it.each(Array.from({ length: 32 }, (_, code) => code))('rejects embedded control character %i', code => {
    expect(ProviderAccountApiKeyInputSchema.safeParse({
      ...input, apiKey: `${apiKey}${String.fromCharCode(code)}suffix`,
    }).success).toBe(false)
  })

  it.each([' ', '\u00a0'])('rejects embedded whitespace %j', whitespace => {
    expect(ProviderAccountApiKeyInputSchema.safeParse({
      ...input, apiKey: `${apiKey}${whitespace}suffix`,
    }).success).toBe(false)
  })
})

describe('provider account chat settings', () => {
  const configurations = [
    DEFAULT_HARNESS_DEFAULTS.codex,
    ClaudeHarnessConfigurationSchema.parse({
      harness: 'claude', model: 'saved-claude-model', authMode: 'subscription',
      configDirectory: '/accounts/claude/home', permissionMode: 'default', sandbox: 'danger-full-access',
      tools: [], permissionRules: [], instructions: '', mcpServers: {},
    }),
  ]

  it.each(configurations)('preserves unchanged $harness configuration without an account', configuration => {
    expect(applyOperatorChatSettings(configuration, operatorChatSettings(configuration)))
      .toStrictEqual(configuration)
  })

  it.each(configurations)('clears a selected $harness account when controls omit it', configuration => {
    const selected = { ...configuration, accountId: '10000000-0000-4000-8000-000000000001' }
    expect(applyOperatorChatSettings(selected, operatorChatSettings(configuration)))
      .toStrictEqual(configuration)
    expect(selected.accountId).toBe('10000000-0000-4000-8000-000000000001')
  })
})
