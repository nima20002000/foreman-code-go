// Run from the repository root after building contracts:
// node scripts/measure-operator-mcp-context.mjs > /tmp/operator-context.json
// To measure a running local app, provide --url and optionally --calls (a JSON
// array of { name, arguments, label?, expectedError? }). Set FOREMAN_CODE_MCP_TOKEN in the environment.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { parseArgs } from 'node:util'

const requireApi = createRequire(new URL('../apps/api/package.json', import.meta.url))
const { Client, InMemoryTransport, StreamableHTTPClientTransport } = await import(
  requireApi.resolve('@modelcontextprotocol/client')
)
const { register } = await import(requireApi.resolve('tsx/esm/api'))
const unregister = register()
const { values } = parseArgs({ options: { url: { type: 'string' }, calls: { type: 'string' } } })

function bytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function resultSize(result) {
  const text = result.content?.filter(part => part.type === 'text').map(part => part.text) ?? []
  const structuredJson = JSON.stringify(result.structuredContent)
  return {
    resultBytes: bytes(result),
    contentBytes: bytes(result.content ?? []),
    textUtf8Bytes: text.reduce((total, part) => total + Buffer.byteLength(part, 'utf8'), 0),
    structuredBytes: structuredJson === undefined ? 0 : Buffer.byteLength(structuredJson, 'utf8'),
    mirroredJson: structuredJson !== undefined && text.includes(structuredJson),
    isError: result.isError === true,
    estimatedStructuredOnlyResultBytes: structuredJson === undefined ? null : bytes({ ...result, content: [] }),
  }
}

async function listCatalog(client) {
  const tools = []
  const pages = []
  const cursors = new Set()
  let cursor
  do {
    const page = await client.request({ method: 'tools/list', params: cursor === undefined ? {} : { cursor } })
    tools.push(...page.tools)
    pages.push({ tools: page.tools.length, resultBytes: bytes(page) })
    cursor = page.nextCursor
    if (cursor !== undefined && cursors.has(cursor)) throw new Error('tools/list repeated a cursor.')
    if (cursor !== undefined) cursors.add(cursor)
  } while (cursor !== undefined)
  // Populate the SDK's output validators after measuring individual protocol pages.
  await client.listTools()
  const sizes = tools.map(tool => ({
    name: tool.name,
    definitionBytes: bytes(tool),
    descriptionUtf8Bytes: Buffer.byteLength(tool.description ?? '', 'utf8'),
    inputSchemaBytes: bytes(tool.inputSchema),
    outputSchemaBytes: tool.outputSchema === undefined ? 0 : bytes(tool.outputSchema),
  }))
  return {
    tools,
    summary: {
      toolCount: tools.length,
      pages,
      totalPageResultBytes: pages.reduce((total, page) => total + page.resultBytes, 0),
      unpaginatedResultBytes: bytes({ tools }),
      catalogSha256: createHash('sha256').update(JSON.stringify(tools)).digest('hex'),
      estimatedWithoutOutputSchemasResultBytes: bytes({
        tools: tools.map(tool => {
          const definition = { ...tool }
          delete definition.outputSchema
          return definition
        }),
      }),
      totals: Object.fromEntries(
        ['definitionBytes', 'descriptionUtf8Bytes', 'inputSchemaBytes', 'outputSchemaBytes']
          .map(key => [key, sizes.reduce((total, tool) => total + tool[key], 0)]),
      ),
      largestTools: sizes.sort((a, b) => b.definitionBytes - a.definitionBytes).slice(0, 12),
    },
  }
}

function fixtureData(schemas, makeCurrentWorkflowFixture) {
  const { CurrentWorkflowReadResultSchema, ManagedWorkspacePageSchema, ManagedWorkspaceDefaultsSchema } = schemas
  const graph = makeCurrentWorkflowFixture('context-measurement', 'parallel')
  const saved = CurrentWorkflowReadResultSchema.parse({
    workspaceId: graph.scope.workspaceId, workflowId: graph.scope.workflowId,
    revision: 1, currentVersionId: graph.version.id, version: graph.version,
  })
  const workspacePage = ManagedWorkspacePageSchema.parse({
    items: Array.from({ length: 50 }, (_, index) => ({
      workspace: {
        id: `workspace-${index}`, name: `Website project ${index}`,
        description: 'A local website workflow workspace.', createdAt: graph.createdAt,
      },
      revision: 1, archivedAt: null, executionLocation: null, locationRevision: 0,
      locationValidation: { status: 'unconfigured' },
    })),
    pageInfo: { nextCursor: null },
  })
  const workspaceDefaults = ManagedWorkspaceDefaultsSchema.parse({
    value: { parentPath: '/demo/Workspaces', suggestedName: 'New workspace', description: '' },
    revision: 1, versionId: 'workspace-defaults-1',
  })
  return { graph, saved, workspacePage, workspaceDefaults }
}

function fixtureServices({ saved, workspacePage, workspaceDefaults }, DomainError) {
  // Empty ports enable real tool registration only. Only the explicitly supplied
  // read callbacks below are invoked; no database, harness, or running app is used.
  return {
    commands: { recordDenied: async () => {} },
    workspaces: {
      storageFolders: {}, list: async (_principal, { limit, cursor }) => {
        const offset = cursor === undefined ? 0 : Number(cursor)
        const nextOffset = offset + limit
        return { items: workspacePage.items.slice(offset, nextOffset),
          pageInfo: { nextCursor: nextOffset < workspacePage.items.length ? String(nextOffset) : null } }
      },
      get: async () => { throw new DomainError('ACCESS_DENIED', 'The resource is outside the caller scope.', 403) },
    },
    workflows: { current: { read: async () => saved }, schedules: {} },
    runs: { inspection: {}, history: {}, subagents: {} },
    locations: {}, agents: {}, harnesses: {}, interactions: {},
    settings: { getWorkspaceDefaults: async () => workspaceDefaults },
    ci: {}, jobs: {}, jobRuntimeProfiles: {}, ciRuntime: {}, workerExecution: {},
    resourceTelemetry: { reads: {}, selectors: {} }, workspaceRoots: {},
    harnessInstances: {}, harnessRegistry: {}, trustedConnections: {},
    computerActivity: {}, computerAccounts: {}, computerMaintenance: {}, computerGitHub: {}, computerSync: {},
    buildComputers: {}, devices: {}, sources: {}, fileReferences: {}, executionReadiness: {},
    runGraph: {}, runPlacements: {}, placementChoices: {}, operatorChat: {}, agentChat: {}, fileRetention: {},
    harnessCompatibility: {}, harnessQualifications: {},
    harnessSettings: { mcp: {}, directories: {}, plugins: {}, claudePlugins: {} },
    extensions: {
      native: {}, agents: {}, history: {}, lifecycle: {}, workspace: { provisioningEnabled: true },
      runs: {}, skills: {}, triggers: {},
    },
  }
}

async function fixture() {
  const source = path => new URL(`../${path}`, import.meta.url).href
  const { ManagementActionSchema, ManagedWorkspacePageSchema, ManagedWorkspaceDefaultsSchema } = await import(
    source('packages/contracts/dist/management/index.js')
  )
  const { CurrentWorkflowReadResultSchema, CURRENT_WORKFLOW_TOOLS } = await import(
    source('packages/contracts/dist/wave25/index.js')
  )
  const { makeCurrentWorkflowFixture } = await import(
    source('packages/contracts/src/wave25/currentFixture.ts'),
  )
  const { DomainError } = await import(source('apps/api/src/modules/errors.ts'))
  const { createGraphqlMcpServer } = await import(source('apps/api/src/mcp/unified/server.ts'))
  const principal = {
    id: 'context-measurement', name: 'Context measurement', audience: 'operator',
    expiresAt: '9999-12-31T00:00:00.000Z', revokedAt: null,
    grants: [{ actions: [...ManagementActionSchema.options], scope: {} }],
  }
  const data = fixtureData({
    CurrentWorkflowReadResultSchema, ManagedWorkspacePageSchema, ManagedWorkspaceDefaultsSchema,
  }, makeCurrentWorkflowFixture)
  const { graph } = data
  const services = fixtureServices(data, DomainError)
  const server = await createGraphqlMcpServer({ role: 'operator', principal, operator: services })
  const [transport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  return {
    transport, close: () => server.close(),
    calls: [
      { label: 'capabilities-full-owner', name: 'operator_get_capabilities', arguments: { detail: 'full' } },
      { label: 'capabilities-compact-owner', name: 'operator_get_capabilities', arguments: {} },
      { label: 'workspace-creation-defaults', name: 'workspace_defaults_get', arguments: {} },
      { label: 'workspace-list-50', name: 'workspace_list', arguments: { limit: 50, detail: 'full' } },
      { label: 'workspace-list-compact-50', name: 'workspace_list', arguments: { limit: 50 } },
      { label: 'workspace-list-default', name: 'workspace_list', arguments: {} },
      { label: 'selected-tool-input', name: 'operator_tool_schema_get', arguments: { name: CURRENT_WORKFLOW_TOOLS.saved } },
      { label: 'selected-tool-output', name: 'operator_tool_schema_get', arguments: {
        name: CURRENT_WORKFLOW_TOOLS.saved, includeOutputSchema: true,
      } },
      { label: 'saved-workflow-4-agents', name: CURRENT_WORKFLOW_TOOLS.saved, arguments: {
        workspaceId: graph.scope.workspaceId, workflowId: graph.scope.workflowId,
      } },
      { label: 'scope-denial', name: 'workspace_get', arguments: { workspaceId: 'outside-scope' }, expectedError: true },
      { label: 'invalid-input', name: CURRENT_WORKFLOW_TOOLS.saved, arguments: {}, expectedError: true },
    ].map(call => ({ expectedError: false, ...call })),
  }
}

async function live() {
  const url = new URL(values.url)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/mcp') {
    throw new Error('--url must be a local HTTP /mcp endpoint without credentials or query parameters.')
  }
  const token = process.env.FOREMAN_CODE_MCP_TOKEN
  if (!token) throw new Error('Live measurement requires FOREMAN_CODE_MCP_TOKEN.')
  const calls = values.calls ? JSON.parse(await readFile(values.calls, 'utf8')) : []
  if (!Array.isArray(calls) || calls.some(call => !call || typeof call.name !== 'string'
    || !call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments)
    || (call.label !== undefined && typeof call.label !== 'string')
    || (call.expectedError !== undefined && typeof call.expectedError !== 'boolean'))) {
    throw new Error('--calls must contain an array of { name, arguments, label?, expectedError? }.')
  }
  return {
    transport: new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: `Bearer ${token}` }, redirect: 'error' },
    }),
    calls, close: async () => {},
  }
}

if (values.calls && !values.url) throw new Error('--calls requires --url.')
const target = values.url ? await live() : await fixture()
const client = new Client({ name: 'operator-context-measurement', version: '1.0.0' })
try {
  await client.connect(target.transport)
  const catalog = await listCatalog(client)
  const results = []
  for (const call of target.calls) {
    const definition = catalog.tools.find(tool => tool.name === call.name)
    if (!definition || definition.annotations?.readOnlyHint !== true) {
      throw new Error(`Measurement only calls advertised read-only tools: ${call.name}`)
    }
    const result = await client.callTool({ name: call.name, arguments: call.arguments })
    if (call.expectedError !== undefined && (result.isError === true) !== call.expectedError) {
      throw new Error(`Unexpected success/error result for measurement: ${call.label ?? call.name}`)
    }
    results.push({ label: call.label ?? call.name, name: call.name, ...resultSize(result) })
  }
  process.stdout.write(`${JSON.stringify({
    mode: values.url ? 'authenticated-local-http' : 'deterministic-in-memory-fixture',
    units: 'UTF-8 bytes of JSON.stringify(result); excludes HTTP/SSE/JSON-RPC framing; not model tokens',
    fixture: values.url ? null : {
      services: 'registration ports enabled; representative reads return schema-validated static data',
      workspaceCount: 50, workflowAgentCount: 4, persisted: false, denial: 'fixture service DomainError',
    },
    catalog: catalog.summary, results,
  }, null, 2)}\n`)
} finally {
  await client.close()
  await target.close()
  await unregister()
}
