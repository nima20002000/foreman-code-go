import { protocolFromBundle } from '../codexProtocol.js'
import { CompatibilityCheckError } from './errors.js'

type ObjectValue = Record<string, unknown>
const invalid = (contract = 'protocol and settings') => new CompatibilityCheckError('PROTOCOL_SETTINGS_UNSUPPORTED',
  `The installed CLI does not advertise the required ${contract} contract.`)
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  return value as ObjectValue
}
/** Local refs only; never fetch a schema, follow external refs, or execute sample requests. */
function resolve(document: ObjectValue, value: unknown, depth = 0): ObjectValue {
  const schema = object(value)
  if (depth > 40) throw invalid()
  if (schema.$ref === undefined) return schema
  if (typeof schema.$ref !== 'string' || !schema.$ref.startsWith('#/')) throw invalid()
  let current: unknown = document
  for (const token of schema.$ref.slice(2).split('/')) {
    const name = token.replace(/~1/g, '/').replace(/~0/g, '~')
    const parent = object(current)
    if (!Object.hasOwn(parent, name)) throw invalid(`schema reference ${name}`)
    current = parent[name]
  }
  return resolve(document, current, depth + 1)
}
function properties(document: ObjectValue, value: unknown): ObjectValue {
  return object(resolve(document, value).properties)
}
function fields(value: ObjectValue, names: readonly string[]): void {
  for (const name of names) if (!Object.hasOwn(value, name) || !value[name] || typeof value[name] !== 'object') throw invalid(`field ${name}`)
}
function requiredFields(document: ObjectValue, schema: unknown, names: readonly string[], context: string): void {
  const required = resolve(document, schema).required
  for (const name of names) {
    if (!Array.isArray(required) || !required.includes(name)) throw invalid(`required ${context}.${name}`)
  }
}
function supportsEnum(document: ObjectValue, value: unknown, expected: readonly string[], depth = 0): void {
  if (depth > 40) throw invalid()
  const schema = resolve(document, value)
  const choices = Array.isArray(schema.enum) ? schema.enum : []
  if (expected.every((item) => choices.includes(item))) return
  for (const choice of [...(Array.isArray(schema.anyOf) ? schema.anyOf : []), ...(Array.isArray(schema.oneOf) ? schema.oneOf : [])]) {
    try { supportsEnum(document, choice, expected, depth + 1); return } catch { /* Try another declared branch. */ }
  }
  throw invalid(`enum values ${expected.join(', ')}`)
}
function supportsType(document: ObjectValue, value: unknown, expected: string, depth = 0): void {
  if (depth > 40) throw invalid()
  const schema = resolve(document, value)
  if (schema.type === expected || (Array.isArray(schema.type) && schema.type.includes(expected))) return
  for (const choice of [...(Array.isArray(schema.anyOf) ? schema.anyOf : []), ...(Array.isArray(schema.oneOf) ? schema.oneOf : [])]) {
    try { supportsType(document, choice, expected, depth + 1); return } catch { /* Another declared branch. */ }
  }
  throw invalid(`type ${expected}`)
}
/** Bound schema shape before handing it to the existing generated-schema compiler. */
export function parseExport(text: string): ObjectValue {
  if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw invalid()
  const root: unknown = JSON.parse(text)
  const pending: { value: unknown; depth: number }[] = [{ value: root, depth: 0 }]
  let count = 0
  while (pending.length) {
    const { value, depth } = pending.pop()!
    if (++count > 250_000 || depth > 96) throw invalid()
    if (value && typeof value === 'object') {
      for (const item of Object.values(value)) pending.push({ value: item, depth: depth + 1 })
    }
  }
  return object(root)
}
export function checkCodexSchema(document: ObjectValue): void {
  try {
    // Reuse the native protocol's required RPC/notification/approval schema checks.
    // This compiles schemas only; no transport or model session is constructed.
    const protocol = protocolFromBundle(document)
    const definitions = object(document.definitions)
    const v2 = definitions.v2 ? object(definitions.v2) : definitions
    for (const name of ['ThreadStartResponse', 'ThreadResumeResponse', 'ThreadForkResponse']) {
      const response = properties(document, v2[name] ?? definitions[name])
      const names = ['thread', 'model', 'modelProvider', 'cwd', 'sandbox', 'approvalPolicy', 'approvalsReviewer', 'reasoningEffort', 'serviceTier']
      fields(response, names)
      requiredFields(document, v2[name] ?? definitions[name], names, name)
    }
    const responseContracts: Record<string, Record<string, string>> = {
      InitializeResponse: { userAgent: 'string' },
      ThreadReadResponse: { thread: 'object' },
      ThreadTurnsListResponse: { data: 'array', nextCursor: 'string' },
      ThreadItemsListResponse: { data: 'array', nextCursor: 'string' },
      ModelListResponse: { data: 'array', nextCursor: 'string' },
      ListMcpServerStatusResponse: { data: 'array', nextCursor: 'string' },
      ConfigReadResponse: { config: 'object' },
      ConfigWriteResponse: { status: 'string', version: 'string' },
      TurnStartResponse: { turn: 'object' },
      TurnSteerResponse: { turnId: 'string' },
      CancelLoginAccountResponse: { status: 'string' },
    }
    for (const [name, contract] of Object.entries(responseContracts)) {
      const response = properties(document, v2[name] ?? definitions[name])
      for (const [field, type] of Object.entries(contract)) {
        try {
          fields(response, [field])
          supportsType(document, response[field], type)
          if (field !== 'nextCursor') requiredFields(document, v2[name] ?? definitions[name], [field], name)
        } catch { throw invalid(`${name}.${field} (${type})`) }
      }
    }
    fields(properties(document, v2.Thread ?? definitions.Thread), ['id', 'turns'])
    requiredFields(document, v2.Thread ?? definitions.Thread, ['id', 'turns'], 'Thread')
    const start = properties(document, v2.ThreadStartParams ?? definitions.ThreadStartParams)
    fields(start, ['model', 'cwd', 'sandbox', 'approvalPolicy', 'approvalsReviewer', 'config', 'ephemeral', 'serviceTier'])
    supportsType(document, start.model, 'string')
    supportsType(document, start.ephemeral, 'boolean')
    supportsType(document, start.config, 'object')
    supportsEnum(document, start.sandbox, ['read-only', 'workspace-write', 'danger-full-access'])
    supportsEnum(document, start.approvalPolicy, ['on-request', 'never'])
    supportsEnum(document, start.approvalsReviewer, ['user', 'auto_review'])
    // These samples are validated in memory, NEVER dispatched to the CLI.
    protocol.request({ id: 1, method: 'thread/start', params: {
      model: 'compatibility-placeholder', cwd: process.cwd(), sandbox: 'read-only',
      approvalPolicy: 'on-request', approvalsReviewer: 'user', ephemeral: true,
      serviceTier: null, config: { model_reasoning_effort: 'low', web_search: 'disabled' },
    } })
    protocol.request({ id: 2, method: 'config/read', params: { includeLayers: false } })
  } catch (error) { throw invalid(error instanceof Error ? error.message : 'protocol and settings') }
}

function operation(document: ObjectValue, path: string, method: string): ObjectValue {
  const route = object(document.paths)[path]
  if (!route || typeof route !== 'object' || !(method in route)) throw invalid(`${method.toUpperCase()} ${path}`)
  return object((route as ObjectValue)[method])
}
function jsonSchema(document: ObjectValue, value: unknown): ObjectValue {
  const content = object(resolve(document, value).content)
  return resolve(document, object(content['application/json']).schema)
}
function commonObjectFields(document: ObjectValue, value: unknown, names: readonly string[], context: string): void {
  const schema = resolve(document, value)
  const choices = schema.oneOf ?? schema.anyOf
  if (Array.isArray(choices)) {
    for (const choice of choices) commonObjectFields(document, choice, names, context)
    return
  }
  fields(properties(document, schema), names)
  requiredFields(document, schema, names, context)
}

function checkOpenCodeResponses(document: ObjectValue): void {
  const contracts: [string, string, Record<string, string>][] = [
    ['/global/health', 'get', { healthy: 'boolean', version: 'string' }],
    ['/session', 'post', { id: 'string', directory: 'string', permission: 'array' }],
    ['/session/{sessionID}', 'get', { id: 'string', directory: 'string', permission: 'array' }],
    ['/provider', 'get', { all: 'array', connected: 'array' }],
  ]
  for (const [path, method, contract] of contracts) {
    const schema = jsonSchema(document, object(operation(document, path, method).responses)['200'])
    const value = properties(document, schema)
    for (const [field, type] of Object.entries(contract)) {
      try {
        fields(value, [field])
        supportsType(document, value[field], type)
        // Directory and permission may be optional in native declarations; attach checks their observed values.
        if (field !== 'directory' && field !== 'permission') requiredFields(document, schema, [field], `${method.toUpperCase()} ${path}`)
      } catch { throw invalid(`${method.toUpperCase()} ${path} response.${field} (${type})`) }
    }
  }
  for (const [path, names] of [
    ['/session/{sessionID}/message', ['info', 'parts']],
    ['/permission', ['id', 'sessionID', 'permission', 'patterns', 'always', 'metadata']],
    ['/question', ['id', 'sessionID']],
    ['/agent', ['name']],
    ['/session/{sessionID}/children', ['id', 'directory', 'parentID']],
  ] as const) {
    const schema = jsonSchema(document, object(operation(document, path, 'get').responses)['200'])
    supportsType(document, schema, 'array')
    const item = resolve(document, schema).items
    fields(properties(document, item), names)
    if (path === '/session/{sessionID}/message') {
      commonObjectFields(document, properties(document, item).info, ['id', 'sessionID', 'role'], 'message.info')
    }
  }
  const message = jsonSchema(document,
    object(operation(document, '/session/{sessionID}/message/{messageID}', 'get').responses)['200'])
  fields(properties(document, message), ['info', 'parts'])
  commonObjectFields(document, properties(document, message).info, ['id', 'sessionID', 'role'], 'message.info')
  const status = jsonSchema(document, object(operation(document, '/session/status', 'get').responses)['200'])
  supportsType(document, status, 'object')
  commonObjectFields(document, resolve(document, status).additionalProperties, ['type'], 'session.status')
}

export function checkOpenCodeSchema(document: ObjectValue): void {
  try {
    if (typeof document.openapi !== 'string' || !/^3\.[01]\./.test(document.openapi)) throw invalid()
    for (const [path, method] of [
      ['/global/health', 'get'], ['/config', 'get'], ['/provider', 'get'], ['/agent', 'get'],
      ['/event', 'get'], ['/session', 'post'], ['/session/{sessionID}', 'get'],
      ['/session/{sessionID}/message', 'get'], ['/session/{sessionID}/prompt_async', 'post'],
      ['/session/{sessionID}/abort', 'post'], ['/permission/{requestID}/reply', 'post'],
      ['/mcp', 'get'],
      ['/session/status', 'get'], ['/session/{sessionID}/message/{messageID}', 'get'],
      ['/permission', 'get'], ['/question', 'get'], ['/question/{requestID}/reject', 'post'],
      ['/session/{sessionID}/fork', 'post'], ['/session/{sessionID}/children', 'get'],
      ['/mcp/{name}/connect', 'post'], ['/mcp/{name}/disconnect', 'post'],
    ] as const) {
      const item = operation(document, path, method)
      if (typeof item.operationId !== 'string' || !item.responses) throw invalid()
    }
    checkOpenCodeResponses(document)
    const config = operation(document, '/config', 'get')
    const settings = properties(document, jsonSchema(document, object(config.responses)['200']))
    fields(settings, ['model', 'agent', 'permission', 'mcp', 'plugin', 'compaction'])
    for (const [name, type] of [['model', 'string'], ['agent', 'object'], ['permission', 'object'], ['mcp', 'object'], ['plugin', 'array'], ['compaction', 'object']] as const) {
      supportsType(document, settings[name], type)
    }
    const session = operation(document, '/session', 'post')
    const sessionFields = properties(document, jsonSchema(document, session.requestBody))
    fields(sessionFields, ['permission'])
    supportsType(document, sessionFields.permission, 'array')
    const rule = properties(document, resolve(document, sessionFields.permission).items)
    fields(rule, ['permission', 'pattern', 'action'])
    supportsEnum(document, rule.action, ['allow', 'ask', 'deny'])
    const prompt = operation(document, '/session/{sessionID}/prompt_async', 'post')
    const promptFields = properties(document, jsonSchema(document, prompt.requestBody))
    fields(promptFields, ['model', 'agent', 'variant', 'parts'])
    for (const [name, type] of [['model', 'object'], ['agent', 'string'], ['variant', 'string'], ['parts', 'array']] as const) {
      supportsType(document, promptFields[name], type)
    }
    fields(properties(document, promptFields.model), ['providerID', 'modelID'])
    const permission = operation(document, '/permission/{requestID}/reply', 'post')
    const reply = properties(document, jsonSchema(document, permission.requestBody))
    fields(reply, ['reply'])
    supportsEnum(document, reply.reply, ['once', 'always', 'reject'])
  } catch (error) { throw invalid(error instanceof Error ? error.message : 'protocol and settings') }
}
