import assert from 'node:assert/strict'
import { afterEach, it, vi } from 'vitest'
import { appLauncherPath } from '../src/modules/harnesses/appMcpLauncher.js'
import { inspectOpenCodeMcpConfiguration } from '../src/modules/harnesses/opencodeMcpConfiguration.js'
import { ManagedOpenCodeServer } from '../src/modules/harnesses/opencodeTransport.js'
import * as processCommands from '../src/modules/harnesses/process.js'

afterEach(() => vi.restoreAllMocks())

for (const mode of ['reference', 'static', 'masked', 'changed-command'] as const) {
  it(`proves a redacted configuration only from the actual unset/nonce resolutions: ${mode}`, async () => {
    const recovery = { root: '/unused-native-registry', owner: 'configuration-owner' }
    const entry = (token: string) => ({ type: 'local', command: [process.execPath, appLauncherPath()],
      enabled: true, environment: { GRAPHQL_MCP_TOKEN: token } })
    vi.spyOn(processCommands, 'runCommand').mockImplementation(async (_binary, args) => ({ exitCode: 0,
      stderr: '', stdout: args[0] === '--version' ? '1.18.31' : JSON.stringify({ mcp: { graphql: entry('***') } }) }))
    const owners: unknown[] = []
    let disposed = 0
    vi.spyOn(ManagedOpenCodeServer.prototype, 'dispose').mockImplementation(async () => { disposed++ })
    vi.spyOn(ManagedOpenCodeServer.prototype, 'request').mockImplementation(async function (this: ManagedOpenCodeServer, path) {
      assert.equal(path, '/config')
      const options = (this as unknown as { options: { processRecovery: unknown;
        environment?: { variables: { GRAPHQL_MCP_TOKEN: string } } } }).options
      owners.push(options.processRecovery)
      const marker = options.environment?.variables.GRAPHQL_MCP_TOKEN
      const resolved = entry(mode === 'static' ? 'literal-token' : mode === 'masked' ? '***' : marker ?? '')
      if (marker && mode === 'changed-command') resolved.command = [process.execPath, '/different/launcher.mjs']
      return Response.json({ mcp: { graphql: resolved } })
    })
    const proof = await inspectOpenCodeMcpConfiguration({ binary: '/unused-native-binary',
      workingDirectory: '/owned-workspace', serverName: 'graphql', processRecovery: recovery })
    assert.equal(proof?.credentialEnvironmentVariable, mode === 'reference' ? 'GRAPHQL_MCP_TOKEN' : undefined)
    assert.equal(proof?.automaticEndpoint, mode === 'reference' ? true : undefined)
    assert.equal(disposed, mode === 'static' || mode === 'masked' ? 1 : 2)
    assert.ok(owners.every((owner) => owner === recovery))
  })
}
