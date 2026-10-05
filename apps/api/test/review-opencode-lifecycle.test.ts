import assert from 'node:assert/strict'
import { it, vi } from 'vitest'
import { OpenCodeNativeSessionManager } from '../src/modules/harnesses/opencodeServer.js'
import { APP_MCP_SERVER_NAME } from '../src/modules/harnesses/appMcpLauncher.js'
import { ManagedOpenCodeServer, childEnvironmentFingerprint } from '../src/modules/harnesses/opencodeTransport.js'
import { FixtureServer, json, permission, request } from './opencode-fixtures.js'

class ResidentFixture extends FixtureServer {
  readonly ownerAgentId = 'agent-1'
  get residentGeneration() { return this.generation }
  readonly inspections: string[] = []
  async requestResident(path: string, signal: AbortSignal, generation: number): Promise<Response | undefined> {
    signal.throwIfAborted()
    if (generation !== this.generation) return undefined
    this.inspections.push(path)
    const url = new URL(path, 'http://fixture.invalid')
    if (url.pathname === '/permission') return json(this.permissions)
    const id = decodeURIComponent(url.pathname.split('/')[2]!)
    return json(this.sessionInfos.get(id))
  }
}

it('F-10 qualifies credential-free chat create and attach without mutating availability inspection', async () => {
  for (const mode of ['create', 'attach'] as const) {
    const fixture = new ResidentFixture()
    fixture.config = { mcp: { [APP_MCP_SERVER_NAME]: { enabled: false } } }
    const server = new ManagedOpenCodeServer({ binary: '/unused-fixture-binary', workingDirectory: '/workspace/project',
      ownerAgentId: 'agent-1', appMcpAccess: 'none' })
    server.expectedVersion = fixture.expectedVersion
    vi.spyOn(server, 'ensure').mockImplementation(signal => fixture.ensure(signal))
    vi.spyOn(server, 'request').mockImplementation((...args) => fixture.request(...args))
    vi.spyOn(server, 'requestResident').mockImplementation((...args) => fixture.requestResident(...args))
    vi.spyOn(server, 'residentGeneration', 'get').mockReturnValue(0)
    vi.spyOn(server, 'dispose').mockImplementation(() => fixture.dispose())
    const restart = vi.spyOn(server, 'restart').mockRejectedValue(new Error('Unexpected credential binding'))
    const native = new OpenCodeNativeSessionManager({ server, ownerAgentId: 'agent-1', appMcpAccess: 'none' })
    try {
      const reference = { harness: 'opencode' as const, providerVersion: fixture.expectedVersion, nativeSessionId: 'ses_test' }
      if (mode === 'attach') fixture.addSession(reference.nativeSessionId)
      const session = mode === 'create' ? await native.createSession({ request: request() })
        : await native.attachSession(reference, { request: request() })
      const ask = permission('request')
      delete ask.tool
      fixture.permissions = [ask]
      const ensure = vi.spyOn(server, 'ensure').mockClear()
      const transport = vi.spyOn(server, 'request').mockClear()
      const result = await native.inspectResponseAvailability(session, {
        nativeRequestId: 'request', nativeRequestType: 'permission.asked', expectedNativeTurnId: 'request',
      })
      assert.equal(result.state, 'available')
      assert.equal(result.qualified, true)
      assert.equal(server.credentialEnvironmentFingerprint, childEnvironmentFingerprint({ agentId: 'agent-1', variables: {} }))
      assert.equal(server.disabledAppMcpServerName, APP_MCP_SERVER_NAME)
      assert.equal(ensure.mock.calls.length, 0)
      assert.equal(transport.mock.calls.length, 0)
      assert.equal(restart.mock.calls.length, 0)
      assert.equal(fixture.inspections.length, 3)
      assert.deepEqual(fixture.permissions, [ask])
    } finally { await native.dispose(); vi.restoreAllMocks() }
  }
})
