import { appLauncherConnection } from '../src/modules/harnesses/appMcpLauncher.js'
import { nativeConnection } from '../src/modules/harnesses/nativeMcpCommon.js'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NATIVE_INTERACTION_FIXTURES } from '@graphql/contracts'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import { describe, it } from 'vitest'

import { canReadInteraction, canRespondToInteraction } from '../src/modules/access/appPolicy.js'
import { decodeInteractionCursor } from '../src/modules/interactions/app.js'
import { McpDetectionService, WorkerLaunchCredentialService, endpointMatches, type NativeMcpEntryEvidence } from '../src/modules/harnesses/mcpDetection.js'
import { ManagedOpenCodeServer } from '../src/modules/harnesses/opencodeServer.js'
import { inspectOpenCodeMcpConfiguration } from '../src/modules/harnesses/opencodeMcpConfiguration.js'
import { CodexAppServerSessionManager } from '../src/modules/harnesses/codexAppServer.js'
import { runCommand, runJsonlProcess } from '../src/modules/harnesses/process.js'
import { redactKnownSecrets, redactSecretText } from '../src/modules/harnesses/secrets.js'

const endpoint = 'http://127.0.0.1:3000/mcp'
const matching: NativeMcpEntryEvidence = {
  name: 'graphql', transport: 'streamable-http', endpoint,
  credentialEnvironmentVariable: 'GRAPHQL_MCP_TOKEN',
}
const context = { harness: 'codex' as const, runnerId: 'runner-local', workingDirectory: process.cwd() }
function detection(entry: NativeMcpEntryEvidence) {
  return new McpDetectionService({ inspect: async () => ({ ...context, providerVersion: '0.154.0', inspectedAt: new Date().toISOString(), entry }) }, endpoint)
}

async function fixture(config: unknown, perform: (binary: string, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'graphql-pr11-provider-'))
  const binary = join(directory, 'opencode-fixture.cjs')
  try {
    await writeFile(join(directory, 'config.json'), JSON.stringify(config))
    // This is an executable provider-protocol fixture, not the real OpenCode binary.
    await writeFile(binary, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('1.18.31'); process.exit(0); }
if (process.argv[2] !== 'debug' || process.argv[3] !== 'config') process.exit(2);
const text = fs.readFileSync('config.json', 'utf8').replace(/\\{env:([^}]+)\\}/g, (_, name) => process.env[name] || '');
console.log(JSON.stringify(JSON.parse(text)));
`, { mode: 0o755 })
    await chmod(binary, 0o755)
    await perform(binary, directory)
  } finally { await rm(directory, { recursive: true, force: true }) }
}

describe('PR #11 secret and launch boundaries', () => {
  it('does not inherit an ambient App token into inspection commands', async () => {
    const previous = process.env.GRAPHQL_MCP_TOKEN
    process.env.GRAPHQL_MCP_TOKEN = 'ambient-pr11-secret'
    try {
      const result = await runCommand(process.execPath, ['-e', 'console.log(Boolean(process.env.GRAPHQL_MCP_TOKEN))'], process.cwd())
      assert.equal(result.stdout.trim(), 'false')
      assert.equal(process.env.GRAPHQL_MCP_TOKEN, 'ambient-pr11-secret')
    } finally {
      if (previous === undefined) delete process.env.GRAPHQL_MCP_TOKEN
      else process.env.GRAPHQL_MCP_TOKEN = previous
    }
  })

  it('redacts nested JSON, escaped JSON arrays, raw stdout, split stderr and returned stderr', async () => {
    const secret = 'scoped-pr11-secret-value'
    const events: unknown[] = []
    const result = await runJsonlProcess({
      binary: process.execPath,
      args: ['-e', `const value = process.env.GRAPHQL_MCP_TOKEN;
console.log(JSON.stringify({type:'proof', nested:[{unrelated:value}], [value]:value}));
console.log('raw ' + value);
console.log('["' + [...value].map(c => '\\\\u' + c.charCodeAt(0).toString(16).padStart(4,'0')).join('') + '"]');
process.stderr.write(value.slice(0, 7));
setTimeout(() => process.stderr.write(value.slice(7) + '\\n'), 10);`],
      cwd: process.cwd(), signal: new AbortController().signal,
      expectedAgentId: 'agent-a', beforeSpawn: async () => ({ agentId: 'agent-a', variables: { GRAPHQL_MCP_TOKEN: secret } }),
      onSpawn: () => undefined, onEvent: async (event) => { events.push(event) },
    })
    assert.equal(result.exitCode, 0)
    assert(!JSON.stringify({ events, stderr: result.stderr }).includes(secret))
    assert(result.stderr.includes('[REDACTED]'))
    const raw = events as Array<{ payload: { text?: string } }>
    const array = raw.find((event) => event.payload.text?.startsWith('['))?.payload.text
    assert.equal(array, '["[REDACTED]"]')
  })

  it('isolates concurrently injected Agent credentials and never puts them in argv', async () => {
    const output = await Promise.all(['agent-a', 'agent-b'].map(async (agentId) => {
      const events: unknown[] = []
      await runJsonlProcess({
        binary: process.execPath,
        args: ['-e', `console.log(JSON.stringify({type:'proof', suffix:process.env.GRAPHQL_MCP_TOKEN.endsWith(${JSON.stringify(agentId)}), argv:process.argv}))`],
        cwd: process.cwd(), signal: new AbortController().signal, expectedAgentId: agentId,
        beforeSpawn: async () => ({ agentId, variables: { GRAPHQL_MCP_TOKEN: `private-pr11-${agentId}` } }),
        onSpawn: () => undefined, onEvent: async (event) => { events.push(event) },
      })
      return events
    }))
    assert(!JSON.stringify(output).includes('private-pr11-'))
    for (const events of output) assert.equal((events[0] as { payload: { suffix: boolean } }).payload.suffix, true)
  })

  it('rejects the wrong environment owner before spawning', async () => {
    let spawned = false
    await assert.rejects(runJsonlProcess({
      binary: process.execPath, args: ['-e', ''], cwd: process.cwd(), signal: new AbortController().signal,
      expectedAgentId: 'agent-a', beforeSpawn: async () => ({ agentId: 'agent-b', variables: { GRAPHQL_MCP_TOKEN: 'private-pr11-other' } }),
      onSpawn: () => { spawned = true }, onEvent: async () => undefined,
    }), /another Agent/)
    assert.equal(spawned, false)
  })

  it('matches known values independent of field names and JSON escaping', () => {
    const secret = 'private-"-pr11-\\-value'
    assert.equal(redactSecretText(JSON.stringify([secret]), [secret]), '["[REDACTED]"]')
    assert.deepEqual(redactKnownSecrets({ nested: [{ unrelated: secret }], [secret]: secret }, [secret]), {
      nested: [{ unrelated: '[REDACTED]' }], '[REDACTED]': '[REDACTED]',
    })
  })

  it('cancels and drains a stuck native command', async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 50)
    try {
      await assert.rejects(runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], process.cwd(), controller.signal))
    } finally { clearTimeout(timer) }
  })
})

describe('PR #11 detection and authorization', () => {
  it('requires the exact route and rejects URL credentials', () => {
    assert(endpointMatches(endpoint, endpoint))
    for (const value of [endpoint + '/', endpoint + '?x=1', endpoint + '#fragment', endpoint.replace('127.0.0.1', 'user:password@127.0.0.1')]) {
      assert.equal(endpointMatches(value, endpoint), false)
    }
  })

  it('does not echo provider error text or native diagnostic strings', async () => {
    for (const text of ['token="private-pr11-value"', '{"token":"private-pr11-value"}', 'Authorization: Basic private-pr11-value']) {
      const service = new McpDetectionService({ inspect: async () => { throw new Error(text) } }, endpoint)
      const result = await service.inspect(context)
      assert.equal(result.detection.state, 'check_failed')
      assert(!JSON.stringify(result).includes('private-pr11-value'))
    }
    const result = await detection({ ...matching, detail: 'private-pr11-value', nativeFilterDiagnostics: ['private-pr11-value'] }).inspect(context)
    assert(!JSON.stringify(result).includes('private-pr11-value'))
    assert(result.nativeFilters.diagnostics?.length)
  })

  it('bounds an unresponsive inspector and propagates its cancellation signal', async () => {
    let observed: AbortSignal | undefined
    const service = new McpDetectionService({ inspect: async (input) => {
      observed = input.signal
      return new Promise(() => undefined)
    } }, endpoint, 'graphql', 25)
    const result = await service.inspect(context)
    assert.equal(result.detection.state, 'check_failed')
    assert.equal(observed?.aborted, true)
  })

  it('separates valid pre-injection authentication requirements from broken connections', async () => {
    assert.equal((await detection({ ...matching, status: 'authentication_required' }).preflight(context)).detection.state, 'authentication_required')
    await assert.rejects(detection({ ...matching, status: 'broken' }).preflight(context), { code: 'APP_MCP_PREFLIGHT_FAILED' })
    await assert.rejects(detection({ ...matching, status: 'authentication_required', credentialEnvironmentVariable: 'OTHER' }).preflight(context), { code: 'APP_MCP_PREFLIGHT_FAILED' })
  })

  it('rejects execution bounds that can outlive the issued credential', () => {
    assert.throws(() => new WorkerLaunchCredentialService(detection(matching), { ttlMs: 900_000 } as never, 'runner-local', 900_000), /30 seconds/)
    assert.doesNotThrow(() => new WorkerLaunchCredentialService(detection(matching), { ttlMs: 900_000 } as never, 'runner-local', 870_000))
  })

  it('rejects malformed decoded cursors before database access', () => {
    const encode = (id: string) => Buffer.from(`interaction:${id}`).toString('base64url')
    assert.equal(decodeInteractionCursor(encode('interaction-valid')), 'interaction-valid')
    for (const id of ['bad\0id', 'bad\nid', '\u0085bad', '', ' leading']) assert.throws(() => decodeInteractionCursor(encode(id)), { code: 'INVALID_CURSOR' })
    for (const value of ['*', encode('ok') + '=', Buffer.from([255, 254]).toString('base64url')]) assert.throws(() => decodeInteractionCursor(value), { code: 'INVALID_CURSOR' })
  })

  it('does not borrow respond permission or partial scope from another grant', () => {
    const principal: ManagementPrincipal = {
      id: 'principal-reviewer', name: 'reviewer', audience: 'worker', agentId: 'reviewer', revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      grants: [
        { actions: ['interactions:read', 'interactions:respond'], scope: { workspaceIds: ['workspace-a'], workflowIds: ['workflow-a'], runIds: ['run-a'] } },
        { actions: ['interactions:read'], scope: { workspaceIds: ['workspace-b'], workflowIds: ['workflow-b'], runIds: ['run-b'] } },
      ],
    }
    const interaction = { ...NATIVE_INTERACTION_FIXTURES.codex, workspaceId: 'workspace-b', workflowId: 'workflow-b', runId: 'run-b', requestingAgentId: 'coder', approval: { handler: 'orchestrator' as const, designatedOrchestratorAgentId: 'reviewer' } }
    assert.equal(canReadInteraction(principal, interaction), true)
    assert.equal(canRespondToInteraction(principal, interaction), false)
    assert.equal(canReadInteraction(principal, { ...interaction, workspaceId: 'workspace-a' }), false)
  })
})

describe.skipIf(process.platform === 'win32')('PR #11 provider-native resolved config protocol', () => {
  it('proves a managed app launcher reference without accepting a static environment value', async () => {
    const entry = nativeConnection('opencode', appLauncherConnection())
    await fixture({ mcp: { 'graphql': entry } }, async (binary, workingDirectory) => {
      const proof = await inspectOpenCodeMcpConfiguration({ binary, workingDirectory, serverName: 'graphql' })
      assert.equal(proof?.automaticEndpoint, true)
      assert.equal(proof?.credentialEnvironmentVariable, 'GRAPHQL_MCP_TOKEN')
      assert.equal(proof?.transport, 'stdio')
    })
    await fixture({ mcp: { 'graphql': { ...entry, environment: { GRAPHQL_MCP_TOKEN: 'static' } } } }, async (binary, workingDirectory) => {
      const proof = await inspectOpenCodeMcpConfiguration({ binary, workingDirectory, serverName: 'graphql' })
      assert.equal(proof?.automaticEndpoint, undefined)
      assert.equal(proof?.credentialEnvironmentVariable, undefined)
    })
  })

  it('proves the exact documented Authorization environment reference after substitution', async () => {
    await fixture({ mcp: { 'graphql': { type: 'remote', url: endpoint, oauth: false, headers: { Authorization: 'Bearer {env:GRAPHQL_MCP_TOKEN}' } } } }, async (binary, workingDirectory) => {
      const entry = await inspectOpenCodeMcpConfiguration({ binary, workingDirectory, serverName: 'graphql' })
      assert.equal(entry?.credentialEnvironmentVariable, 'GRAPHQL_MCP_TOKEN')
      assert.equal(entry?.status, 'status_unavailable')
      assert(!JSON.stringify(entry).includes('graphql_probe_'))
    })
  })

  it('does not prove a reference to a retired per-role credential variable', async () => {
    await fixture({ mcp: { graphql: { type: 'remote', url: endpoint, oauth: false, headers: { Authorization: 'Bearer {env:GRAPHQL_OPERATOR_MCP_TOKEN}' } } } }, async (binary, workingDirectory) => {
      const entry = await inspectOpenCodeMcpConfiguration({ binary, workingDirectory, serverName: 'graphql' })
      assert.equal(entry?.credentialEnvironmentVariable, undefined)
      assert(!JSON.stringify(entry).includes('graphql_probe_'))
    })
  })

  it('rejects unrelated headers, static tokens, bare references, and OAuth mode', async () => {
    for (const config of [
      { oauth: false, headers: { 'X-Other': '{env:GRAPHQL_MCP_TOKEN}' } },
      { oauth: false, headers: { Authorization: 'Bearer static-private-pr11' } },
      { oauth: false, headers: { Authorization: '{env:GRAPHQL_MCP_TOKEN}' } },
      { headers: { Authorization: 'Bearer {env:GRAPHQL_MCP_TOKEN}' } },
    ]) {
      await fixture({ mcp: { 'graphql': { type: 'remote', url: endpoint, ...config } } }, async (binary, workingDirectory) => {
        const entry = await inspectOpenCodeMcpConfiguration({ binary, workingDirectory, serverName: 'graphql' })
        assert.equal(entry?.credentialEnvironmentVariable, undefined)
      })
    }
  })
})


describe.skipIf(process.platform === 'win32')('PR #11 Codex inspection failure classification', () => {
  it('reports absence only when a successful structured list proves it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'graphql-pr11-codex-'))
    const binary = join(directory, 'codex-fixture.cjs')
    try {
      for (const [exitCode, stdout, expected] of [
        [0, '[]', 'CODEX_MCP_NOT_CONFIGURED'],
        [1, '', 'CODEX_MCP_INSPECTION_FAILED'],
        [0, '{bad json', 'CODEX_MCP_INSPECTION_FAILED'],
        [0, '[{"name":"graphql"}]', 'CODEX_MCP_INSPECTION_FAILED'],
      ] as const) {
        await writeFile(binary, `#!${process.execPath}
if (process.argv[3] === 'get') { console.error('configuration unavailable'); process.exit(1); }
process.stdout.write(${JSON.stringify(stdout)}); process.exit(${exitCode});
`, { mode: 0o755 })
        await chmod(binary, 0o755)
        const manager = new CodexAppServerSessionManager(binary)
        // Qualification itself is covered separately; exercise only the get/list subprocess path.
        const inspection = manager as unknown as { mcpConfiguration(
          binary: string, cwd: string, environment: NodeJS.ProcessEnv, providerVersion: string,
        ): Promise<unknown> }
        await assert.rejects(inspection.mcpConfiguration(binary, directory, { ...process.env }, 'codex-cli 0.154.0'), (error: unknown) => {
          const failure = error as { result?: { error?: { code?: string } } }
          assert.equal(failure.result?.error?.code, expected)
          return true
        })
      }
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})


describe.skipIf(process.platform === 'win32')('PR #11 resident process credential cleanup', () => {
  it('scrubs ambient App tokens and redacts shutdown stderr after the manager clears its environment', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'graphql-pr11-resident-'))
    const binary = join(directory, 'resident-fixture.cjs')
    const previous = process.env.GRAPHQL_MCP_TOKEN
    process.env.GRAPHQL_MCP_TOKEN = 'ambient-pr11-resident-value'
    const server = new ManagedOpenCodeServer({ binary, workingDirectory: directory, ownerAgentId: 'agent-a' })
    try {
      await writeFile(binary, `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('1.18.31'); process.exit(0); }
const http = require('node:http');
const value = process.env.GRAPHQL_MCP_TOKEN;
const server = http.createServer((request, response) => {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(request.url === '/global/health' ? {healthy:true,version:'1.18.31'} : {present:Boolean(value)}));
});
process.on('SIGTERM', () => process.stderr.write(String(value || 'unset') + '\\n', () => server.close(() => process.exit(0))));
server.listen(0, '127.0.0.1', () => console.log('opencode server listening on http://127.0.0.1:' + server.address().port));
`, { mode: 0o755 })
      await chmod(binary, 0o755)
      await server.ensure()
      assert.deepEqual(await (await server.request('/environment')).json(), { present: false })
      await server.restart({ agentId: 'agent-a', variables: { GRAPHQL_MCP_TOKEN: 'scoped-pr11-resident-value' } })
      assert.deepEqual(await (await server.request('/environment')).json(), { present: true })
      await server.dispose()
      const stderr = String(Reflect.get(server, 'stderr'))
      assert(stderr.includes('[REDACTED]'))
      assert(!stderr.includes('scoped-pr11-resident-value'))
    } finally {
      await server.dispose()
      if (previous === undefined) delete process.env.GRAPHQL_MCP_TOKEN
      else process.env.GRAPHQL_MCP_TOKEN = previous
      await rm(directory, { recursive: true, force: true })
    }
  })
})
