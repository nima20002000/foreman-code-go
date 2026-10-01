import assert from 'node:assert/strict'
import { afterEach, it, vi } from 'vitest'
import * as nativeProcess from '../src/modules/harnesses/process.js'
import { ManagedOpenCodeServer } from '../src/modules/harnesses/opencodeTransport.js'

afterEach(() => { vi.restoreAllMocks() })
it('keeps all configuration qualification probes in the identical owner recovery scope', async () => {
  const recovery = { root: '/unused-replay-registry', owner: 'qualification-owner', launchId: 'reserved-launch' }
  const calls: unknown[] = []
  let assertions = 0
  vi.spyOn(nativeProcess, 'runCommand').mockImplementation(async (_binary, args, _cwd, _signal, environment, options) => {
    calls.push(options?.recovery)
    if (args[0] === '--version') return { exitCode: 0, stdout: '1.18.31', stderr: '' }
    return { exitCode: 0, stderr: '', stdout: JSON.stringify({ mcp: { graphql: {
      type: 'remote', oauth: false, url: 'http://127.0.0.1:4100/mcp/app', headers: { Authorization: environment ? 'Bearer [REDACTED]' : 'Bearer ' },
    } } }) }
  })
  const server = new ManagedOpenCodeServer({ binary: '/unused-replay-binary', workingDirectory: '/work', ownerAgentId: 'owner', processRecovery: recovery,
    assertInstallation: async () => { assertions++ },
  })
  const evidence = await server.inspectMcpConfiguration('/work', 'graphql')
  assert.equal(evidence?.credentialEnvironmentVariable, 'GRAPHQL_MCP_TOKEN')
  assert.equal(calls.length, 3)
  assert.equal(assertions, 6)
  assert(calls.every(scope => scope === recovery))
})

it('rechecks the installation around each config subprocess and stops before later probes on mismatch', async () => {
  const steps: string[] = []
  vi.spyOn(nativeProcess, 'runCommand').mockImplementation(async (_binary, args) => {
    steps.push(args.join(' '))
    return { exitCode: 0, stdout: '1.18.31', stderr: '' }
  })
  const server = new ManagedOpenCodeServer({ binary: '/unused-replay-binary', workingDirectory: '/work', ownerAgentId: 'owner',
    assertInstallation: async () => {
      steps.push('assert')
      if (steps.length === 3) throw new Error('installation payload changed after version')
    },
  })
  await assert.rejects(server.inspectMcpConfiguration('/work', 'graphql'), /payload changed/)
  assert.deepEqual(steps, ['assert', '--version', 'assert'])
})
