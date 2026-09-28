import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { buildOpenCodeChatConfigContent, assertOpenCodeChatMcpDisabled } from '../src/modules/harnesses/opencodeTransport.js'

describe('OpenCode chat App MCP isolation', () => {
  it('disables configured current and legacy App MCP entries without changing unrelated servers', () => {
    const inherited = { model: 'fixture', mcp: {
      graphql: { type: 'local', enabled: true },
      'graphql-app': { type: 'remote', enabled: true },
      'graphql-operator': { type: 'remote', enabled: true },
      docs: { type: 'remote', enabled: true },
    } }
    const overlay = buildOpenCodeChatConfigContent(JSON.stringify(inherited), 'graphql')
    assert.equal(overlay, buildOpenCodeChatConfigContent(overlay, 'graphql'))
    const config = JSON.parse(overlay)
    for (const name of ['graphql', 'graphql-app', 'graphql-operator']) {
      assert.deepEqual(config.mcp[name], { ...inherited.mcp[name as keyof typeof inherited.mcp], enabled: false })
    }
    assert.deepEqual(config.mcp.docs, inherited.mcp.docs)
    assert.equal(inherited.mcp['graphql-operator'].enabled, true)
    assert.deepEqual(JSON.parse(buildOpenCodeChatConfigContent(undefined, 'graphql')).mcp, {
      graphql: { enabled: false }, 'graphql-app': { enabled: false }, 'graphql-operator': { enabled: false },
    })
    const disabled = Object.fromEntries(['graphql', 'graphql-app', 'graphql-operator']
      .map((name) => [name, { status: 'disabled' }]))
    assert.doesNotThrow(() => assertOpenCodeChatMcpDisabled(config, disabled, 'graphql'))
    for (const name of ['graphql-app', 'graphql-operator']) {
      assert.throws(() => assertOpenCodeChatMcpDisabled(config, { ...disabled, [name]: { status: 'connected' } }, 'graphql'),
        (error: { result?: { error?: { code?: string } } }) => error.result?.error?.code === 'OPENCODE_APP_MCP_UNAVAILABLE')
      assert.throws(() => assertOpenCodeChatMcpDisabled({ ...config, mcp: { ...config.mcp, [name]: { enabled: true } } }, disabled, 'graphql'),
        (error: { result?: { error?: { code?: string } } }) => error.result?.error?.code === 'OPENCODE_APP_MCP_UNAVAILABLE')
    }
  })
})
