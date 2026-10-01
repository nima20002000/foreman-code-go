import { describe, expect, it } from 'vitest'
import { claudeMcpDetection, decodeClaudeMcpControl } from './mcpInspection.js'
const now = '2026-10-01T00:00:00.000Z'
describe('actual SDK MCP control evidence', () => {
  it.each([['pending', 'status_unavailable'], ['failed', 'broken'], ['needs-auth', 'authentication_required'], ['disabled', 'disabled'], ['connected', 'connected']])('maps real status %s without saved-config health', (status, state) => {
    const snapshot = decodeClaudeMcpControl([{ name: 'graphql', status, source: 'dynamic', config: { type: 'http', url: 'http://127.0.0.1:3000/mcp' } }], 'generation', now)
    expect(claudeMcpDetection(snapshot, { serverName: 'graphql', url: 'http://127.0.0.1:3000/mcp' }).state).toBe(state)
  })
  it('withholds credential values, token URLs and command arguments from public inspection', () => {
    const snapshot = decodeClaudeMcpControl([{ name: 'graphql', status: 'connected', source: 'dynamic', config: { type: 'stdio', command: '/local/node', args: ['--token', 'private-argument'], env: { GRAPHQL_MCP_TOKEN: 'private-environment' }, headers: { Authorization: 'private-header' } } },
      { name: 'other', status: 'connected', config: { type: 'http', url: 'http://user:password@host/mcp?token=private-url' } }], 'generation', now)
    expect(JSON.stringify(snapshot)).not.toMatch(/private-|password/)
    expect(snapshot.servers[0]?.configuration?.argumentCount).toBe(2)
    expect(claudeMcpDetection(snapshot, { serverName: 'graphql' }).credentialEnvironmentVariable).toBe('GRAPHQL_MCP_TOKEN')
    expect(snapshot.servers[1]?.configuration?.url).toBeUndefined()
  })
  it('rejects malformed/unbounded native status instead of labeling a saved entry connected', () => {
    expect(() => decodeClaudeMcpControl([{ name: 'graphql', status: 'future-status' }], 'g', now)).toThrow('malformed')
    expect(() => decodeClaudeMcpControl(Array.from({ length: 129 }, () => ({ name: 'graphql', status: 'connected' })), 'g', now)).toThrow('bounded')
    expect(claudeMcpDetection(decodeClaudeMcpControl([], 'g', now), { serverName: 'graphql' }).state).toBe('not_detected')
  })
})
