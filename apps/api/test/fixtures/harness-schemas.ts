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
  const threadResponse = { type: 'object', properties: {
    thread: { $ref: '#/definitions/v2/Thread' }, model: { type: 'string' }, cwd: { type: 'string' },
    sandbox: { type: 'object' }, approvalPolicy: { type: 'string' }, approvalsReviewer: { type: 'string' },
  } }
  return { $schema: 'http://json-schema.org/draft-07/schema#', definitions: {
    ClientRequest: { oneOf: methods.map(branch) }, ServerRequest: { oneOf: serverMethods.map(branch) },
    ServerNotification: { oneOf: ['turn/started', 'turn/completed', 'item/started', 'item/completed', 'serverRequest/resolved'].map(branch) },
    v2: { ...Object.fromEntries(responses.map((name) => [name, { type: 'object' }])), ThreadStartParams: start,
      ThreadStartResponse: threadResponse, ThreadResumeResponse: threadResponse,
      Thread: { type: 'object', properties: { id: { type: 'string' }, turns: { type: 'array', items: { type: 'object' } } } },
      TurnStartResponse: { type: 'object', properties: { turn: { type: 'object' } } },
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
