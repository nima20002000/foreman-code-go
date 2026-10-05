import { expect, it } from 'vitest'
import { CodexAppServerSessionManager, type CodexSessionDependencies } from '../src/modules/harnesses/codexAppServer.js'
import { QUALIFIED_CODEX_VERSION } from '../src/modules/harnesses/codexProtocol.js'
import { fixtureProtocol } from './fixtures/codex-test-helpers.js'

function fixture(entries: Record<string, { enabled: boolean }>,
  options: { commandFailure?: string; requestedName?: string } = {}) {
  const commands: string[][] = []
  const forbidden = () => { throw new Error('Inspection cannot start native sessions or model work.') }
  const dependencies: Extract<CodexSessionDependencies, { mode: 'replay' }> = {
    mode: 'replay', environment: () => ({}),
    qualify: async (binary) => ({ binary, identity: 'recorded-launcher', protocol: fixtureProtocol,
      providerVersion: QUALIFIED_CODEX_VERSION, schemaManifestSha256: 'recorded', stableSchemaGitBlob: 'recorded',
      referenceSchemaManifestSha256: 'recorded' }),
    assertUnchanged: forbidden, qualifyModel: forbidden, transport: forbidden,
    withDiagnostics: forbidden, id: () => 'recorded', now: () => new Date(), schedule: setTimeout, cancelTimer: clearTimeout,
    runCommand: async (_binary, args) => {
      commands.push(args)
      const name = args[2]!
      if (options.commandFailure) return { exitCode: 1, stdout: '', stderr: options.commandFailure }
      const entry = entries[name]
      if (!entry) return { exitCode: 1, stdout: '', stderr: `Error: No MCP server named '${name}' found.` }
      return { exitCode: 0, stderr: '', stdout: JSON.stringify({ name, enabled: entry.enabled,
        transport: { type: 'streamable_http', url: 'http://127.0.0.1:3040/mcp',
          bearer_token_env_var: 'FOREMAN_CODE_MCP_TOKEN' }, disabled_tools: ['files.publish_result'] }) }
    },
  }
  return { manager: new CodexAppServerSessionManager('/recorded-codex', undefined, options.requestedName,
    undefined, undefined, undefined, dependencies), commands }
}

it.each(['foreman-code', 'graphql'])('reads %s configuration without a global catalog listing', async (name) => {
  const f = fixture({ [name]: { enabled: true } })
  const result = await f.manager.inspectMcpConfiguration('/accepted-project')
  expect(result).toMatchObject({ cwd: '/accepted-project', serverName: name,
    configured: { enabled: true, bearerTokenEnvironmentVariable: 'FOREMAN_CODE_MCP_TOKEN',
      disabledTools: ['files.publish_result'] } })
  expect(f.commands).toEqual([['mcp', 'get', 'foreman-code', '--json'], ['mcp', 'get', 'graphql', '--json']])
})

it('keeps both enabled and disabled names in collision detection', async () => {
  const f = fixture({ 'foreman-code': { enabled: true }, graphql: { enabled: false } })
  expect((await f.manager.inspectMcp()).state).toBe('check_failed')
})

it('distinguishes a definite missing entry from an inspection failure', async () => {
  expect((await fixture({}).manager.inspectMcp()).state).toBe('not_detected')
  expect((await fixture({}, { commandFailure: 'Configuration could not be read.' }).manager.inspectMcp()).state).toBe('check_failed')
})

it('inspects an explicitly requested custom name without changing its binding', async () => {
  const f = fixture({ docs: { enabled: true } }, { requestedName: 'docs' })
  expect((await f.manager.inspectMcp()).serverName).toBe('docs')
  expect(f.commands).toEqual([['mcp', 'get', 'docs', '--json']])
})
