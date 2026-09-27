import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkCodexSchema, checkOpenCodeSchema, parseExport } from '../src/modules/harnesses/compatibility/schema.js'
import { diagnosticEnvironment, parseInstalledVersion, schemaExportArguments } from '../src/modules/harnesses/compatibility/probe.js'

/** Synthetic schemas test the diagnostic itself; they are not provider qualification evidence. */
function codexSchema() {
  const methods = ['initialize', 'thread/start', 'thread/resume', 'thread/read', 'thread/turns/list', 'thread/items/list', 'turn/start', 'turn/interrupt', 'config/read', 'model/list', 'config/batchWrite', 'mcpServerStatus/list', 'account/login/start', 'account/login/cancel']
  const serverMethods = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput', 'mcpServer/elicitation/request']
  const responses = ['InitializeResponse', 'ThreadStartResponse', 'ThreadResumeResponse', 'ThreadReadResponse', 'ThreadTurnsListResponse', 'ThreadItemsListResponse', 'TurnStartResponse', 'TurnInterruptResponse', 'ConfigReadResponse', 'ModelListResponse', 'ConfigWriteResponse', 'ListMcpServerStatusResponse', 'LoginAccountResponse', 'CancelLoginAccountResponse', 'CommandExecutionRequestApprovalResponse', 'FileChangeRequestApprovalResponse', 'PermissionsRequestApprovalResponse', 'ToolRequestUserInputResponse', 'McpServerElicitationRequestResponse']
  const branch = (method: string) => ({ type: 'object', properties: {
    method: { const: method }, id: { type: 'integer' },
    params: method === 'thread/start' ? { $ref: '#/definitions/v2/ThreadStartParams' } : { type: 'object' },
  }, required: ['method'] })
  const start = { type: 'object', properties: {
    model: { type: 'string' }, cwd: { type: 'string' }, ephemeral: { type: 'boolean' }, config: { type: 'object' },
    serviceTier: { type: ['string', 'null'] },
    sandbox: { type: 'string', enum: ['read-only', 'workspace-write', 'danger-full-access'] },
    approvalPolicy: { type: 'string', enum: ['on-request', 'never'] },
    approvalsReviewer: { type: 'string', enum: ['user', 'auto_review'] },
  } }
  return { $schema: 'http://json-schema.org/draft-07/schema#', definitions: {
    ClientRequest: { oneOf: methods.map(branch) }, ServerRequest: { oneOf: serverMethods.map(branch) },
    ServerNotification: { oneOf: ['turn/started', 'turn/completed', 'item/started', 'item/completed', 'serverRequest/resolved'].map(branch) },
    v2: { ...Object.fromEntries(responses.map((name) => [name, { type: 'object' }])), ThreadStartParams: start },
  } }
}
function openCodeSchema() {
  const paths: Record<string, Record<string, Record<string, unknown>>> = {}
  for (const [path, method] of [
    ['/global/health', 'get'], ['/config', 'get'], ['/provider', 'get'], ['/agent', 'get'], ['/event', 'get'],
    ['/session', 'post'], ['/session/{sessionID}', 'get'], ['/session/{sessionID}/message', 'get'],
    ['/session/{sessionID}/prompt_async', 'post'], ['/session/{sessionID}/abort', 'post'],
    ['/permission/{requestID}/reply', 'post'], ['/mcp', 'get'],
  ]) paths[path!] = { [method!]: { operationId: `${path}:${method}`, responses: { '200': {} } } }
  const body = (properties: Record<string, unknown>) => ({ content: { 'application/json': { schema: { type: 'object', properties } } } })
  paths['/config']!.get!.responses = { '200': body({ model: { type: 'string' }, agent: { type: 'object' }, permission: { type: 'object' }, mcp: { type: 'object' }, plugin: { type: 'array' }, compaction: { type: 'object' } }) }
  paths['/session']!.post!.requestBody = body({ permission: { type: 'array', items: { type: 'object', properties: {
    permission: { type: 'string' }, pattern: { type: 'string' }, action: { type: 'string', enum: ['allow', 'ask', 'deny'] },
  } } } })
  paths['/session/{sessionID}/prompt_async']!.post!.requestBody = body({ model: { type: 'object', properties: { providerID: { type: 'string' }, modelID: { type: 'string' } } }, agent: { type: 'string' }, variant: { type: 'string' }, parts: { type: 'array' } })
  paths['/permission/{requestID}/reply']!.post!.requestBody = body({ reply: { type: 'string', enum: ['once', 'always', 'reject'] } })
  return { openapi: '3.1.0', paths }
}
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
    expect(() => checkCodexSchema(broken)).toThrow('protocol and settings')
  })
  it('requires OpenCode permission replies, settings and control methods', () => {
    expect(() => checkOpenCodeSchema(openCodeSchema())).not.toThrow()
    const broken = openCodeSchema()
    delete broken.paths['/permission/{requestID}/reply']
    expect(() => checkOpenCodeSchema(broken)).toThrow()
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
