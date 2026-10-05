import { afterEach, expect, it, vi } from 'vitest'
import { inspectOpenCodeMcpConfiguration } from '../src/modules/harnesses/opencodeMcpConfiguration.js'
import * as commands from '../src/modules/harnesses/process.js'
import { redactKnownSecrets } from '../src/modules/harnesses/secrets.js'

afterEach(() => vi.restoreAllMocks())

it.each(['reference', 'static', 'other-header', 'endpoint', 'transport'] as const)(
  'checks active remote authentication despite inherited local fields: %s', async mode => {
    const endpoint = 'http://127.0.0.1:41781/mcp'
    vi.spyOn(commands, 'runCommand').mockImplementation(async (_binary, args, _directory, _signal, environment) => {
      if (args[0] === '--version') return { exitCode: 0, stdout: '1.18.31', stderr: '' }
      const injected = await environment?.beforeSpawn?.()
      const marker = injected?.variables.GRAPHQL_MCP_TOKEN ?? ''
      const config = { mcp: { graphql: {
        type: marker && mode === 'transport' ? 'local' : 'remote',
        url: marker && mode === 'endpoint' ? 'http://127.0.0.1:41782/mcp' : endpoint,
        enabled: true,
        oauth: false,
        headers: { Authorization: `Bearer ${mode === 'static' ? 'literal-token' : marker}`,
          ...(mode === 'other-header' ? { 'X-Other': marker } : {}) },
        command: ['node', 'inherited-launcher.mjs'],
        environment: { GRAPHQL_MCP_TOKEN: marker },
      } } }
      return { exitCode: 0, stdout: JSON.stringify(redactKnownSecrets(config, [marker])), stderr: '' }
    })
    const result = await inspectOpenCodeMcpConfiguration({ binary: '/qualified-opencode',
      workingDirectory: '/operator', serverName: 'graphql' })
    expect(result).toMatchObject({ transport: 'streamable-http', endpoint, enabled: true })
    expect(result?.credentialEnvironmentVariable).toBe(mode === 'reference' ? 'GRAPHQL_MCP_TOKEN' : undefined)
    expect(JSON.stringify(result)).not.toContain('literal-token')
    expect(JSON.stringify(result)).not.toContain('graphql_probe_')
  },
)
