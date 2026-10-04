import assert from 'node:assert/strict'
import { afterEach, it, vi } from 'vitest'
import { appLauncherPath } from '../src/modules/harnesses/appMcpLauncher.js'
import { inspectOpenCodeMcpConfiguration } from '../src/modules/harnesses/opencodeMcpConfiguration.js'
import type { ManagedOpenCodeServer } from '../src/modules/harnesses/opencodeTransport.js'
import * as openCodeTransport from '../src/modules/harnesses/opencodeTransport.js'
import * as processCommands from '../src/modules/harnesses/process.js'
import { redactKnownSecrets } from '../src/modules/harnesses/secrets.js'

afterEach(() => vi.restoreAllMocks())

for (const [serverName, tokenName, requestedVariable] of [
  ['graphql', 'GRAPHQL_MCP_TOKEN', undefined],
  ['foreman-code', 'FOREMAN_CODE_MCP_TOKEN', undefined],
  ['graphql', 'GRAPHQL_MCP_TOKEN', 'FOREMAN_CODE_MCP_TOKEN'],
  ['foreman-code', 'FOREMAN_CODE_MCP_TOKEN', 'GRAPHQL_MCP_TOKEN'],
] as const) {
for (const mode of ['reference', 'static', 'masked', 'changed-command'] as const) {
  it(`proves an unset/nonce reference: ${serverName}, ${requestedVariable ?? 'default'}, ${mode}`, async () => {
    const recovery = { root: '/unused-native-registry', owner: 'configuration-owner' }
    const entry = (token: string) => ({ type: 'local', command: [process.execPath, appLauncherPath()],
      enabled: true, environment: { [tokenName]: token } })
    vi.spyOn(processCommands, 'runCommand').mockImplementation(async (_binary, args) => ({ exitCode: 0,
      stderr: '', stdout: args[0] === '--version' ? '1.18.31' : JSON.stringify({ mcp: { [serverName]: entry('***') } }) }))
    const owners: unknown[] = []
    let disposed = 0
    vi.spyOn(openCodeTransport, 'ManagedOpenCodeServer').mockImplementation(function (options) {
      owners.push(options.processRecovery)
      const marker = options.environment?.variables[tokenName]
      const resolved = entry(mode === 'static' ? 'literal-token' : mode === 'masked' ? '***' : marker ?? '')
      if (marker && mode === 'changed-command') resolved.command = [process.execPath, '/different/launcher.mjs']
      return { request: async (path: string) => {
        assert.equal(path, '/config')
        return Response.json({ mcp: { [serverName]: resolved } })
      }, redact: <T>(value: T): T => {
        return redactKnownSecrets(value, marker ? [marker] : [])
      }, dispose: async () => { disposed++ } } as ManagedOpenCodeServer
    })
    const proof = await inspectOpenCodeMcpConfiguration({ binary: '/unused-native-binary',
      workingDirectory: '/owned-workspace', serverName, processRecovery: recovery,
      ...(requestedVariable ? { credentialEnvironmentVariable: requestedVariable } : {}) })
    assert.equal(proof?.credentialEnvironmentVariable, mode === 'reference' ? tokenName : undefined)
    assert.equal(proof?.automaticEndpoint, mode === 'reference' ? true : undefined)
    assert.equal(disposed, mode === 'static' || mode === 'masked' ? 1 : 2)
    assert.ok(owners.every((owner) => owner === recovery))
  })
}
}
