import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { configuration, OPEN_CODE_MODEL, SCENARIOS, scenarioGraph, seed } from './scenarios.mjs'

const workflow = { id: 'wf-test', workspaceId: 'ws-test', name: 'test', executionSemanticsVersion: 3,
  entryNodeId: null, nodes: [], edges: [], executionCondition: { kind: 'manual' } }
test('all eight concrete scenarios use semantics 3 and distinct real Agent identities', () => {
  const ids = new Set()
  for (const spec of SCENARIOS) {
    const { graph, agents } = scenarioGraph(spec, workflow)
    assert.equal(graph.executionSemanticsVersion, 3)
    assert.equal(graph.nodes.length, spec.nodes.length)
    assert.equal(agents.length, graph.nodes.length)
    assert.equal(graph.entryNodeId, graph.nodes[0].id)
    assert.equal(graph.approval.handler, 'user')
    for (const { agent, baseRevision } of agents) {
      assert.equal(baseRevision, null); assert.equal(agent.configurationVersionId, undefined)
      assert.equal(agent.harnessConfiguration.model, OPEN_CODE_MODEL)
      assert.equal(ids.has(agent.id), false); ids.add(agent.id)
    }
    assert.equal(graph.edges.every((edge) => edge.kind === 'execution'), true)
    assert.equal(Object.hasOwn(graph, 'repeat'), Boolean(spec.repeat))
  }
  assert.equal(ids.size, 27)
})
test('ordinary workflows never manufacture a repeat plan, even an empty one', () => {
  for (const spec of SCENARIOS.filter((item) => !item.repeat)) {
    assert.equal(JSON.stringify(scenarioGraph(spec, workflow).graph).includes('"repeat"'), false)
  }
})
test('parallel diamond and unequal conditional paths have explicit all-required joins', () => {
  const parallel = scenarioGraph(SCENARIOS.find((spec) => spec.key === 'S3-02'), workflow).graph
  assert.equal(parallel.executionPolicy.maxParallelism, 2)
  assert.deepEqual(parallel.nodes.at(-1).join, { mode: 'all' })
  for (const route of ['short', 'long']) {
    const spec = SCENARIOS.find((item) => item.route === route)
    const graph = scenarioGraph(spec, workflow).graph
    assert.equal(graph.nodes.length, 5); assert.equal(graph.edges.length, 5)
    assert.deepEqual(graph.nodes.at(-1).join, { mode: 'all' })
    assert.deepEqual(graph.nodes[0].choice.outcomes.map((item) => item.outcome), ['short', 'long'])
    assert.equal(spec.executions, route === 'short' ? 3 : 4)
    assert.match(graph.nodes[0].initialPrompt, new RegExp(`"outcome":"${route}"`))
  }
})
test('repeat limits include the first occurrence and preserve findings at exhaustion', () => {
  for (const spec of SCENARIOS.filter((item) => item.repeat)) {
    const graph = scenarioGraph(spec, workflow).graph
    const block = graph.repeat.blocks[0]
    assert.equal(block.maxOccurrences, 3)
    assert.equal(graph.executionPolicy.maxNodeExecutions, block.maxOccurrences * block.nodeIds.length)
    assert.deepEqual(block.limitExit, { kind: 'branch_end' })
    assert.deepEqual(graph.nodes[1].choice.outcomes.map((item) => item.outcome), ['pass', 'issues'])
    const envelope = JSON.parse(graph.nodes[1].initialPrompt.match(/Return exactly (.*)\.$/)[1])
    assert.deepEqual(Object.keys(envelope), ['routing', 'data'])
    assert.deepEqual(Object.keys(envelope.data), ['latestDeliverable', 'remainingFindings'])
    assert.equal(envelope.routing.outcome, spec.repeat === 'early' ? 'pass' : 'issues')
    assert.equal(envelope.data.remainingFindings.length, spec.repeat === 'early' ? 0 : 1)
    assert.equal(spec.executions, spec.repeat === 'early' ? 2 : 6)
  }
})
test('human approval is narrow, GraphQL-routed and never native auto-approval', () => {
  const spec = SCENARIOS.find((item) => item.approval)
  const { graph, agents } = scenarioGraph(spec, workflow)
  const cfg = agents[0].agent.harnessConfiguration
  assert.equal(cfg.autoApprove, false); assert.equal(cfg.advanced.permissionHandling, 'graphql_routed')
  assert.deepEqual(cfg.advanced.permissionRules, [
    { permission: '*', pattern: '*', effect: 'deny' },
    { permission: 'bash', pattern: 'printf ENG07_APPROVED', effect: 'ask' },
  ])
  assert.match(graph.nodes[0].initialPrompt, /exactly once/)
  assert.equal(graph.repeat, undefined)
})
test('optional Codex changes exactly the parallel Right branch, with read-only sandbox', () => {
  const spec = SCENARIOS.find((item) => item.key === 'S3-02')
  const { agents } = scenarioGraph(spec, workflow, 'owner-supplied-model')
  assert.deepEqual(agents.map((item) => item.agent.harness), ['opencode', 'opencode', 'codex', 'opencode'])
  const codex = agents[2].agent.harnessConfiguration
  assert.equal(codex.model, 'owner-supplied-model'); assert.equal(codex.sandbox, 'read-only')
  assert.equal(codex.advanced.sessionPersistence, 'persistent')
  assert.equal(codex.advanced.approvalPolicy, 'on-request')
  assert.deepEqual(codex.advanced.shellEnvironment.set, {})
})
// This is a request-contract test, NOT product/PG/native acceptance evidence.
// Product schemas are exercised by the real --smoke path, not mocked as proof.
test('seed uses real-route request shapes and reserved journal commands, never Run Start', async () => {
  const state = await mkdtemp(join(await realpath('/tmp'), 'eng07-fixture-'))
  const folder = join(state, 'ENG07 Acceptance'); await mkdir(folder)
  const original = globalThis.fetch
  const staged = [], calls = []
  let n = 0, current
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname, body = init.body && JSON.parse(init.body)
    calls.push({ path, method: init.method, body })
    assert.equal(init.headers.origin, 'http://127.0.0.1:5307')
    let result
    if (path === '/api/management/workspaces') result = { value: { workspace: { id: 'ws-test' },
      executionLocation: { rootPath: folder }, locationValidation: { status: 'ready' }, locationRevision: 1 } }
    else if (path.endsWith('/workflows')) { current = { ...workflow, id: `wf-${++n}` }; result = { value: { workflow: current, revision: 0 } } }
    else if (path.endsWith('/edits') && init.method === 'POST' && body.action === 'stage_edits') {
      assert.deepEqual(body.expectedAgentConfigurationVersionIds, {})
      assert.equal(body.expectedWorkflowVersionId, null); staged.push(body); result = {}
    } else if (path.endsWith('/edits') && init.method === 'GET') result = { intent: { id: `intent-${n}`, advanceCommandId: `reserved-command-${n}`, affected: [] } }
    else if (path.endsWith('/edits')) {
      assert.equal(body.action, 'stop_and_save'); assert.equal(body.commandId, `reserved-command-${n}`); result = {}
    } else if (path.endsWith('/definition')) {
      const item = staged.at(-1)
      result = { version: { id: `version-${n}`, executionSemanticsVersion: 3, definition: item.graph,
        agentConfigurationVersionIds: Object.fromEntries(item.stagedAgents.map(({ agent }) => [agent.id, `cfg-${agent.id}`])) } }
    } else if (path.endsWith('/agents')) result = { items: staged.flatMap((item) => item.stagedAgents.map(({ agent }) => ({ agent: { ...agent, configurationVersionId: `cfg-${agent.id}` } }))) }
    else throw new Error('Unexpected route')
    return new Response(JSON.stringify(result), { status: 200 })
  }
  try {
    const parse = { parse: (value) => value }
    const demo = await seed({ apiUrl: 'http://127.0.0.1:3307', webUrl: 'http://127.0.0.1:5307', projectRoot: state,
      schemas: { CurrentEditStageInputSchema: parse, CurrentWorkflowReadResultSchema: parse } })
    assert.equal(demo.workflowIds.length, 8); assert.equal(demo.agentCount, 27)
    assert.equal(calls.some((call) => call.path.includes('/runs')), false)
    const native = JSON.parse(await readFile(join(folder, 'opencode.json'), 'utf8'))
    assert.deepEqual(native.mcp['graphql-app'], { type: 'remote', url: 'http://127.0.0.1:3307/mcp/tools',
      enabled: true, oauth: false, headers: { Authorization: 'Bearer {env:GRAPHQL_APP_MCP_TOKEN}' } })
    assert.equal(calls.filter((call) => call.body?.action === 'stage_edits').length, 8)
    assert.equal(calls.filter((call) => call.body?.action === 'stop_and_save').length, 8)
  } finally { globalThis.fetch = original; await rm(state, { recursive: true, force: true }) }
})
test('seed does not blindly resubmit a failed or uncertain write', async () => {
  const original = globalThis.fetch; let requests = 0
  globalThis.fetch = async () => { requests++; return new Response('{}', { status: 503 }) }
  try {
    await assert.rejects(seed({ apiUrl: 'http://127.0.0.1:3307', webUrl: 'http://127.0.0.1:5307', projectRoot: '/unused', schemas: {} }))
    assert.equal(requests, 1)
  } finally { globalThis.fetch = original }
})
