import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkCodexSchema, checkOpenCodeSchema, parseExport } from '../src/modules/harnesses/compatibility/schema.js'
import { diagnosticEnvironment, parseInstalledVersion, schemaExportArguments } from '../src/modules/harnesses/compatibility/probe.js'

import { codexSchema, openCodeSchema } from './fixtures/harness-schemas.js'

describe('model-free command and schema diagnostics', () => {
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
  it('rejects Codex history fields that are declared optional despite being consumed unconditionally', () => {
    const broken = codexSchema()
    broken.definitions.v2.ThreadReadResponse.required = []
    expect(() => checkCodexSchema(broken)).toThrow('ThreadReadResponse.thread')
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
