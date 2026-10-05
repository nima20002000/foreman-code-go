/** Synthetic schemas test the diagnostic itself; they are not provider qualification evidence. */
export function codexSchema() {
  const methods = ['initialize', 'thread/start', 'thread/resume', 'thread/read', 'thread/turns/list', 'thread/items/list', 'turn/start', 'turn/interrupt', 'turn/steer', 'thread/fork', 'config/read', 'model/list', 'config/batchWrite', 'mcpServerStatus/list', 'account/login/start', 'account/login/cancel']
  const serverMethods = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput', 'mcpServer/elicitation/request']
  const responses = ['InitializeResponse', 'ThreadStartResponse', 'ThreadResumeResponse', 'ThreadReadResponse', 'ThreadTurnsListResponse', 'ThreadItemsListResponse', 'TurnStartResponse', 'TurnInterruptResponse', 'TurnSteerResponse', 'ThreadForkResponse', 'ConfigReadResponse', 'ModelListResponse', 'ConfigWriteResponse', 'ListMcpServerStatusResponse', 'LoginAccountResponse', 'CancelLoginAccountResponse', 'CommandExecutionRequestApprovalResponse', 'FileChangeRequestApprovalResponse', 'PermissionsRequestApprovalResponse', 'ToolRequestUserInputResponse', 'McpServerElicitationRequestResponse']
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
  const threadResponse = { type: 'object', required: ['thread', 'model', 'modelProvider', 'cwd', 'sandbox', 'approvalPolicy', 'approvalsReviewer', 'reasoningEffort', 'serviceTier'], properties: {
    thread: { $ref: '#/definitions/v2/Thread' }, model: { type: 'string' }, modelProvider: { type: 'string' },
    reasoningEffort: { type: ['string', 'null'] }, serviceTier: { type: ['string', 'null'] }, cwd: { type: 'string' },
    sandbox: { type: 'object' }, approvalPolicy: { type: 'string' }, approvalsReviewer: { type: 'string' },
  } }
  return { $schema: 'http://json-schema.org/draft-07/schema#', definitions: {
    ClientRequest: { oneOf: methods.map(branch) }, ServerRequest: { oneOf: serverMethods.map(branch) },
    ServerNotification: { oneOf: ['turn/started', 'turn/completed', 'item/started', 'item/completed', 'serverRequest/resolved'].map(branch) },
    v2: { ...Object.fromEntries(responses.map((name) => [name, { type: 'object' }])), ThreadStartParams: start,
      ThreadStartResponse: threadResponse, ThreadResumeResponse: threadResponse, ThreadForkResponse: threadResponse,
      ThreadReadResponse: { type: 'object', required: ['thread'], properties: { thread: { $ref: '#/definitions/v2/Thread' } } },
      ...Object.fromEntries(['ThreadTurnsListResponse', 'ThreadItemsListResponse', 'ModelListResponse', 'ListMcpServerStatusResponse'].map(name =>
        [name, { type: 'object', required: ['data'], properties: { data: { type: 'array', items: { type: 'object' } }, nextCursor: { type: ['string', 'null'] } } }])),
      InitializeResponse: { type: 'object', required: ['userAgent'], properties: { userAgent: { type: 'string' } } },
      ConfigReadResponse: { type: 'object', required: ['config'], properties: { config: { type: 'object' } } },
      ConfigWriteResponse: { type: 'object', required: ['status', 'version'], properties: { status: { type: 'string' }, version: { type: 'string' } } },
      TurnSteerResponse: { type: 'object', required: ['turnId'], properties: { turnId: { type: 'string' } } },
      CancelLoginAccountResponse: { type: 'object', required: ['status'], properties: { status: { type: 'string' } } },
      Thread: { type: 'object', required: ['id', 'turns'], properties: { id: { type: 'string' }, turns: { type: 'array', items: { type: 'object' } } } },
      TurnStartResponse: { type: 'object', required: ['turn'], properties: { turn: { type: 'object' } } },
    },
  } }
}
export function openCodeSchema() {
  const paths: Record<string, Record<string, Record<string, unknown>>> = {}
  for (const [path, method] of [
    ['/global/health', 'get'], ['/config', 'get'], ['/provider', 'get'], ['/agent', 'get'], ['/event', 'get'],
    ['/session', 'post'], ['/session/{sessionID}', 'get'], ['/session/{sessionID}/message', 'get'],
    ['/session/{sessionID}/prompt_async', 'post'], ['/session/{sessionID}/abort', 'post'],
    ['/permission/{requestID}/reply', 'post'], ['/mcp', 'get'],
      ['/session/status', 'get'], ['/session/{sessionID}/message/{messageID}', 'get'],
      ['/permission', 'get'], ['/question', 'get'], ['/question/{requestID}/reject', 'post'],
      ['/session/{sessionID}/fork', 'post'], ['/session/{sessionID}/children', 'get'],
      ['/mcp/{name}/connect', 'post'], ['/mcp/{name}/disconnect', 'post'],
  ]) paths[path!] = { [method!]: { operationId: `${path}:${method}`, responses: { '200': {} } } }
  const content = (schema: Record<string, unknown>) => ({ content: { 'application/json': { schema } } })
  const body = (properties: Record<string, unknown>) => content({ type: 'object', properties, required: Object.keys(properties) })
  const sessionResponse = body({ id: { type: 'string' }, directory: { type: 'string' }, permission: { type: 'array', items: { type: 'object' } } })
  paths['/session']!.post!.responses = { '200': sessionResponse }
  paths['/session/{sessionID}']!.get!.responses = { '200': sessionResponse }
  paths['/global/health']!.get!.responses = { '200': body({ healthy: { type: 'boolean' }, version: { type: 'string' } }) }
  paths['/provider']!.get!.responses = { '200': body({ all: { type: 'array', items: { type: 'object' } }, connected: { type: 'array', items: { type: 'string' } } }) }
  const message = { type: 'object', properties: { info: { type: 'object', required: ['id', 'sessionID', 'role'], properties: { id: { type: 'string' }, sessionID: { type: 'string' }, role: { type: 'string' } } }, parts: { type: 'array', items: { type: 'object' } } } }
  const arrays: Record<string, Record<string, unknown>> = {
    '/session/{sessionID}/message': message,
    '/permission': { type: 'object', properties: { id: { type: 'string' }, sessionID: { type: 'string' }, permission: { type: 'string' },
      patterns: { type: 'array', items: { type: 'string' } }, always: { type: 'array', items: { type: 'string' } }, metadata: { type: 'object' } } },
    '/question': { type: 'object', properties: { id: { type: 'string' }, sessionID: { type: 'string' } } },
    '/agent': { type: 'object', properties: { name: { type: 'string' } } },
    '/session/{sessionID}/children': { type: 'object', properties: { id: { type: 'string' }, directory: { type: 'string' }, parentID: { type: 'string' } } },
  }
  for (const [path, items] of Object.entries(arrays)) paths[path]!.get!.responses = { '200': content({ type: 'array', items }) }
  paths['/session/{sessionID}/message/{messageID}']!.get!.responses = { '200': content(message) }
  paths['/session/status']!.get!.responses = { '200': content({ type: 'object', additionalProperties: { type: 'object', required: ['type'], properties: { type: { type: 'string' } } } }) }
  paths['/config']!.get!.responses = { '200': body({ model: { type: 'string' }, agent: { type: 'object' }, permission: { type: 'object' }, mcp: { type: 'object' }, plugin: { type: 'array' }, compaction: { type: 'object' } }) }
  paths['/session']!.post!.requestBody = body({ permission: { type: 'array', items: { type: 'object', properties: {
    permission: { type: 'string' }, pattern: { type: 'string' }, action: { type: 'string', enum: ['allow', 'ask', 'deny'] },
  } } } })
  paths['/session/{sessionID}/prompt_async']!.post!.requestBody = body({ model: { type: 'object', properties: { providerID: { type: 'string' }, modelID: { type: 'string' } } }, agent: { type: 'string' }, variant: { type: 'string' }, parts: { type: 'array' } })
  paths['/permission/{requestID}/reply']!.post!.requestBody = body({ reply: { type: 'string', enum: ['once', 'always', 'reject'] } })
  return { openapi: '3.1.0', paths }
}
