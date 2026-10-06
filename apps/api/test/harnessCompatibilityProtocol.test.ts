import assert from 'node:assert/strict'
import { join } from 'node:path'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { checkCodexSchema, checkOpenCodeSchema, parseExport } from '../src/modules/harnesses/compatibility/schema.js'
import { diagnosticEnvironment, nativeCompatibilityProbe, parseInstalledVersion, schemaExportArguments } from '../src/modules/harnesses/compatibility/probe.js'
import { CompatibilityCheckError } from '../src/modules/harnesses/compatibility/errors.js'

import { protocolFromBundle } from '../src/modules/harnesses/codexProtocol.js'
import { codexSchema, openCodeSchema } from './fixtures/harness-schemas.js'

describe('model-free command and schema diagnostics', () => {
  it.skipIf(process.platform === 'win32').each(['codex', 'opencode'] as const)(
    'names the harness, observed version and export command when %s refuses its contract', async harness => {
      const directory = await mkdtemp(join(tmpdir(), 'harness-export-contract-'))
      const binary = join(directory, 'harness.mjs')
      const version = harness === 'codex' ? 'codex-cli 0.158.0' : '2.0.0'
      await writeFile(binary, `#!${process.execPath}
if (process.argv.includes('--version')) {
  console.log(${JSON.stringify(version)})
} else {
  console.error('private-credential')
  process.exitCode = 1
}
`)
      await chmod(binary, 0o700)
      const probe = nativeCompatibilityProbe({ codex: binary, opencode: binary }, directory)
      const signal = AbortSignal.timeout(15_000)
      try {
        const installation = await probe.inspect(harness, signal)
        await assert.rejects(probe.probe(harness, installation, signal), (error: unknown) => {
          assert(error instanceof CompatibilityCheckError)
          expect(error.code).toBe('CLI_CHECK_REJECTED')
          expect(error.message).toContain(`${harness} ${installation.version}`)
          expect(error.message).toContain(harness === 'codex' ? 'app-server generate-json-schema --experimental' : '--pure generate')
          expect(error.message).not.toContain('private-credential')
          return true
        })
      } finally {
        try {
          assert(probe.close)
          await probe.close()
        }
        finally { await rm(directory, { recursive: true, force: true }) }
      }
    }, 20_000)
  it('only constructs export commands, never run, exec, serve, sessions or prompts', () => {
    expect(schemaExportArguments('codex', '/isolated')).toEqual(['app-server', 'generate-json-schema', '--experimental', '--out', join('/isolated', 'schemas')])
    expect(schemaExportArguments('opencode', '/isolated')).toEqual(['--pure', 'generate'])
  })
  it('removes real credentials, config overrides and executable preload hooks', () => {
    const environment = diagnosticEnvironment('/isolated', {
      PATH: '/bin', HOME: '/real/home', OPENAI_API_KEY: 'secret', GRAPHQL_MCP_TOKEN: 'secret',
      BETTER_AUTH_SECRET: 'secret', NODE_OPTIONS: '--require malicious', OPENCODE_CONFIG: '/private/config',
      DATABASE_URL: 'postgresql://secret', OPENCODE_CONFIG_CONTENT: '{"plugin":["external"]}',
    })
    expect(environment.HOME).toBe('/isolated')
    expect(environment.CODEX_HOME).toBe(join('/isolated', 'codex'))
    expect(environment.PATH).toBe('/bin')
    expect(environment.OPENCODE_DISABLE_MODELS_FETCH).toBe('1')
    expect(JSON.stringify(environment)).not.toMatch(/secret|malicious|external|private|real\/home/)
  })
  it('accepts exact version output, retaining prerelease identity and rejecting extra output', () => {
    expect(parseInstalledVersion('codex', 'codex-cli 0.154.0\n', '')).toBe('0.154.0')
    expect(parseInstalledVersion('opencode', '', '1.18.32-beta.1')).toBe('1.18.32-beta.1')
    expect(() => parseInstalledVersion('codex', 'codex-cli 0.154.0\nextra', '')).toThrow()
    expect(() => parseInstalledVersion('opencode', 'codex-cli 0.154.0', '')).toThrow()
  })
  it('validates Codex RPC and settings schemas without sending any request', () => {
    expect(() => checkCodexSchema(codexSchema())).not.toThrow()
    const broken = codexSchema()
    broken.definitions.v2.ThreadStartParams.properties.approvalsReviewer.enum = ['user']
    expect(() => checkCodexSchema(broken)).toThrow('enum values user, auto_review')
  })
  it('rejects a missing Codex history field before reporting compatibility', () => {
    const broken = codexSchema()
    const response = broken.definitions.v2.ThreadReadResponse
    Reflect.deleteProperty(response.properties, 'thread')
    expect(() => checkCodexSchema(broken)).toThrow('ThreadReadResponse.thread')
  })
  it('accepts optional declarations while requiring consumed fields in observed Codex responses', () => {
    const broken = codexSchema()
    broken.definitions.v2.ThreadReadResponse.required = []
    expect(() => checkCodexSchema(broken)).not.toThrow()
    const protocol = protocolFromBundle(broken, 'codex-cli 0.160.0')
    expect(() => protocol.response('thread/read', { thread: { id: 'saved-thread', turns: [] } })).not.toThrow()
    expect(() => protocol.response('thread/read', {})).toThrow('0.160.0')
    expect(() => protocol.response('thread/read', {})).toThrow('ThreadReadResponse.thread')
  })
  it('rejects OpenCode session creation schemas that cannot return an unconditional session ID', () => {
    const broken = openCodeSchema()
    broken.paths['/session']!.post!.responses = { '200': { content: { 'application/json': {
      schema: { type: 'object', properties: {}, required: [] },
    } } } }
    expect(() => checkOpenCodeSchema(broken)).toThrow('POST /session response.id')
  })
  it('requires OpenCode permission replies, settings and control methods', () => {
    expect(() => checkOpenCodeSchema(openCodeSchema())).not.toThrow()
    const broken = openCodeSchema()
    delete broken.paths['/permission/{requestID}/reply']
    expect(() => checkOpenCodeSchema(broken)).toThrow()
  })
  it('accepts compatible OpenCode fields even when their declarations are optional', () => {
    const schema = openCodeSchema()
    const response = schema.paths['/session']!.post!.responses as { '200': { content: {
      'application/json': { schema: { required: string[] } }
    } } }
    response['200'].content['application/json'].schema.required = []
    expect(() => checkOpenCodeSchema(schema)).not.toThrow()
  })
  it('rejects a native prompt contract that cannot preserve child system instructions', () => {
    const schema = openCodeSchema()
    const body = schema.paths['/session/{sessionID}/prompt_async']!.post!.requestBody as {
      content: { 'application/json': { schema: { properties: Record<string, unknown> } } }
    }
    delete body.content['application/json'].schema.properties.system
    expect(() => checkOpenCodeSchema(schema)).toThrow('system')
  })
  it.each(['/session/status', '/question/{requestID}/reject', '/session/{sessionID}/message/{messageID}'])(
    'names a missing OpenCode reconciliation or cleanup contract: %s', path => {
      const broken = openCodeSchema()
      delete broken.paths[path]
      expect(() => checkOpenCodeSchema(broken)).toThrow(path)
    })
  it('rejects external refs and empty/deep exports instead of guessing compatibility', () => {
    const broken = openCodeSchema()
    broken.paths['/session']!.post!.requestBody = { $ref: 'https://example.invalid/schema' }
    expect(() => checkOpenCodeSchema(broken)).toThrow()
    expect(() => checkCodexSchema({})).toThrow()
    let value: unknown = {}
    for (let index = 0; index < 100; index++) value = { nested: value }
    expect(() => parseExport(JSON.stringify(value))).toThrow()
  })
})
