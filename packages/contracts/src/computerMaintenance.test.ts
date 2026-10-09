import { describe, expect, it } from 'vitest'
import { SyncedMcpServerSchema } from './computerMaintenance.js'
import { HarnessMcpConnectionSchema } from './management/harnessSettings.js'

describe('fleet MCP credential restrictions', () => {
  it.each([
    'https://service.example/mcp?api_key=fixture-secret',
    'https://owner:fixture-secret@service.example/mcp',
    'https://service.example/mcp#fixture-secret',
  ])('rejects credential-bearing endpoints at native and fleet boundaries: %s', url => {
    expect(HarnessMcpConnectionSchema.safeParse({ transport: 'remote', url }).success).toBe(false)
    expect(SyncedMcpServerSchema.safeParse({ transport: 'http', name: 'docs', url,
      bearerTokenEnvVar: null }).success).toBe(false)
  })

  it.each([
    ['--api-key=fixture-secret'], ['--api-key', 'fixture-secret'],
    ['--access-token', 'fixture-secret'], ['Authorization: Bearer fixture-secret'],
    ['--password:fixture-secret'],
  ].map(args => ({ args })))('rejects inline arguments at native and fleet boundaries: %j', ({ args }) => {
    expect(HarnessMcpConnectionSchema.safeParse({ transport: 'stdio', executable: '/usr/bin/server',
      arguments: args }).success).toBe(false)
    expect(SyncedMcpServerSchema.safeParse({ transport: 'stdio', name: 'docs', command: '/usr/bin/server',
      args, envVars: [] }).success).toBe(false)
  })

  it('accepts per-computer authentication references and ordinary server arguments', () => {
    expect(SyncedMcpServerSchema.safeParse({ transport: 'http', name: 'docs',
      url: 'https://service.example/mcp', bearerTokenEnvVar: 'SERVICE_TOKEN' }).success).toBe(true)
    expect(SyncedMcpServerSchema.safeParse({ transport: 'stdio', name: 'docs', command: 'npx',
      args: ['server-token', '--token-env-var', 'SERVICE_TOKEN'], envVars: [] }).success).toBe(true)
  })
})

