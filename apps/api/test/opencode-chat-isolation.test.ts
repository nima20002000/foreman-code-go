import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { buildOpenCodeChatConfigContent, assertOpenCodeChatMcpDisabled } from '../src/modules/harnesses/opencodeTransport.js'

describe('OpenCode chat App MCP isolation', () => {
  it.each(['foreman-code', 'graphql'])('isolates App MCP entries selected through %s', (serverName) => {
    const inherited = { model: 'fixture', mcp: {
      'foreman-code': { type: 'local', enabled: true },
      graphql: { type: 'local', enabled: true },
      'graphql-app': { type: 'remote', enabled: true },
      'graphql-operator': { type: 'remote', enabled: true },
      docs: { type: 'remote', enabled: true },
    } }
    const overlay = buildOpenCodeChatConfigContent(JSON.stringify(inherited), serverName)
    assert.equal(overlay, buildOpenCodeChatConfigContent(overlay, serverName))
    const config = JSON.parse(overlay)
    for (const name of ['foreman-code', 'graphql', 'graphql-app', 'graphql-operator']) {
      assert.deepEqual(config.mcp[name], { ...inherited.mcp[name as keyof typeof inherited.mcp], enabled: false })
    }
    assert.deepEqual(config.mcp.docs, inherited.mcp.docs)
    const legacy = Object.fromEntries(Object.entries(inherited.mcp).filter(([name]) => name !== 'foreman-code'))
    const legacyConfig = JSON.parse(buildOpenCodeChatConfigContent(JSON.stringify({ mcp: legacy }), 'graphql'))
    assert.deepEqual(legacyConfig.mcp['foreman-code'], { enabled: false })
    assert.equal(inherited.mcp['foreman-code'].enabled, true)
    assert.equal(inherited.mcp['graphql-operator'].enabled, true)
    assert.deepEqual(JSON.parse(buildOpenCodeChatConfigContent(undefined, 'foreman-code')).mcp, {
      'foreman-code': { enabled: false }, graphql: { enabled: false },
      'graphql-app': { enabled: false }, 'graphql-operator': { enabled: false },
    })
    const disabled = Object.fromEntries(['foreman-code', 'graphql', 'graphql-app', 'graphql-operator']
      .map((name) => [name, { status: 'disabled' }]))
    assert.doesNotThrow(() => assertOpenCodeChatMcpDisabled(config, disabled, 'foreman-code'))
    assert.doesNotThrow(() => assertOpenCodeChatMcpDisabled(config, disabled, 'graphql'))
    const legacyDisabled = Object.fromEntries(Object.entries(disabled).filter(([name]) => name !== 'foreman-code'))
    assert.doesNotThrow(() => assertOpenCodeChatMcpDisabled(legacyConfig, legacyDisabled, 'graphql'))
    for (const name of ['foreman-code', 'graphql', 'graphql-app', 'graphql-operator']) {
      assert.throws(() => assertOpenCodeChatMcpDisabled(config, { ...disabled, [name]: { status: 'connected' } }, 'foreman-code'),
        (error: { result?: { error?: { code?: string } } }) => error.result?.error?.code === 'OPENCODE_APP_MCP_UNAVAILABLE')
      assert.throws(() => assertOpenCodeChatMcpDisabled({ ...config, mcp: { ...config.mcp, [name]: { enabled: true } } }, disabled, 'foreman-code'),
        (error: { result?: { error?: { code?: string } } }) => error.result?.error?.code === 'OPENCODE_APP_MCP_UNAVAILABLE')
    }
  })
})
