import { access, chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HarnessExecutionRequest, NativeSessionReference } from '@graphql/contracts'
import { afterEach, describe, expect, it } from 'vitest'

import { CodexAppServerSessionManager } from '../src/modules/harnesses/codexAppServer.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function request(directory: string, agentId = 'agent-a'): HarnessExecutionRequest {
  return {
    executionId: `execution-${agentId}`, runId: 'run-1', workspaceId: 'workspace-1', workflowNodeId: 'node-1',
    workingDirectory: directory, runtimeDirectory: directory, input: {},
    configuration: {
      id: `config-${agentId}`, workspaceId: 'workspace-1', agentId, version: 1,
      prompt: { system: 'Test the native transport.' }, assignedSkills: [],
      harness: { harness: 'codex', model: 'test-model', reasoningEffort: 'medium', sandbox: 'read-only', serviceTier: 'standard' },
      contentHash: 'sha256:test', createdAt: '2026-09-16T00:00:00.000Z',
    },
  }
}

const fakeCodex = `#!${process.execPath}
const args = process.argv.slice(2)
if (args[0] === '--version') { console.log('codex-cli 0.154.0'); process.exit(0) }
if (args[0] === 'login') { console.log('Logged in using ChatGPT'); process.exit(0) }
if (args[0] === 'mcp' && args[1] === 'get') {
  console.log(JSON.stringify({name:args[2],enabled:true,required:true,transport:{type:'streamable_http',url:'http://127.0.0.1:3000/mcp/app',bearer_token_env_var:'GRAPHQL_APP_MCP_TOKEN'},enabled_tools:['context_get'],disabled_tools:['interaction_respond']})); process.exit(0)
}
if (args[0] !== 'app-server') process.exit(2)
const readline = require('node:readline')
const rl = readline.createInterface({input:process.stdin,crlfDelay:Infinity})
const agent = process.env.TEST_AGENT_ID || 'missing'
const threadId = 'thread-' + agent
let turn = 0
const send = value => process.stdout.write(JSON.stringify(value)+'\\n')
if (process.env.TEST_EXIT_MARKER) {
  const markExit = () => require('node:fs').writeFileSync(process.env.TEST_EXIT_MARKER, 'exited')
  process.on('exit', markExit)
  process.on('SIGTERM', () => process.exit(0))
}
rl.on('line', line => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') send({id:message.id,result:{userAgent:'codex-cli 0.154.0',codexHome:'/tmp/codex',platformFamily:'unix',platformOs:'linux'}})
  else if (message.method === 'initialized') {}
  else if (message.method === 'thread/start') process.env.TEST_FAIL_THREAD_START
    ? send({id:message.id,error:{code:-32000,message:'forced start failure'}})
    : send({id:message.id,result:{thread:{id:threadId,ephemeral:false,turns:[]}}})
  else if (message.method === 'thread/resume') process.env.TEST_FAIL_THREAD_RESUME
    ? send({id:message.id,error:{code:-32000,message:'forced resume failure'}})
    : send({id:message.id,result:{thread:{id:threadId,turns:[]}}})
  else if (message.method === 'thread/read') send({id:message.id,result:{thread:{id:threadId,turns:[]}}})
  else if (message.method === 'config/read') send({id:message.id,result:{config:{approval_policy:'on-request'},origins:{},layers:[]}})
  else if (message.method === 'mcpServerStatus/list') send({id:message.id,result:{data:[{name:'graphql-app',runtimeStatus:'connected',tools:{context_get:{name:'context_get'}},toolsError:null,resources:[],resourceTemplates:[],authStatus:'bearerToken'}],nextCursor:null}})
  else if (message.method === 'config/mcpServer/reload') send({id:message.id,result:{}})
  else if (message.method === 'model/list') send({id:message.id,result:{data:[{id:'test-model',supportedReasoningEfforts:['medium'],serviceTiers:['fast']}],nextCursor:null}})
  else if (message.method === 'account/login/start') send({id:message.id,result:{type:'chatgptDeviceCode',loginId:'login-1',verificationUrl:'https://example.invalid/device',userCode:'SAFE-CODE'}})
  else if (message.method === 'account/login/cancel') send({id:message.id,result:{}})
  else if (message.method === 'turn/start') {
    turn += 1
    const turnId = 'turn-' + turn
    const prompt = message.params.input[0].text
    send({id:message.id,result:{turn:{id:turnId,status:'inProgress',items:[]}}})
    if (prompt === 'approve') {
      send({method:'item/commandExecution/requestApproval',id:900+turn,params:{threadId,turnId,itemId:'command-1',startedAtMs:1,command:'printf harmless',cwd:process.cwd(),availableDecisions:['accept','acceptForSession','decline','cancel']}})
    } else if (prompt === 'crash') process.exit(17)
    else if (prompt === 'cancel me') {}
    else {
      send({method:'protocol/newNotification',params:{threadId,turnId,value:true}})
      send({method:'item/completed',params:{threadId,turnId,completedAtMs:2,item:{type:'agentMessage',id:'message-'+turn,text:'answer-'+agent,phase:'final_answer'}}})
      send({method:'item/completed',params:{threadId,turnId,completedAtMs:2,item:{type:'agentMessage',id:'message-'+turn,text:'answer-'+agent,phase:'final_answer'}}})
      send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed',items:[],error:null}}})
    }
  } else if (message.method === 'turn/interrupt') {
    send({id:message.id,result:{}})
    send({method:'turn/completed',params:{threadId,turn:{id:message.params.turnId,status:'interrupted',items:[],error:null}}})
  } else if (!message.method && message.id >= 900) {
    if (message.result.decision !== 'acceptForSession') process.exit(33)
    const turnId = 'turn-' + turn
    send({method:'item/completed',params:{threadId,turnId,completedAtMs:3,item:{type:'agentMessage',id:'approved',text:'approved-'+agent,phase:'final_answer'}}})
    send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed',items:[],error:null}}})
  }
})
`

async function fixture(): Promise<{ manager: CodexAppServerSessionManager; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'graphql-codex-app-server-'))
  directories.push(directory)
  const binary = join(directory, 'codex.cjs')
  await writeFile(binary, fakeCodex)
  await chmod(binary, 0o700)
  return { manager: new CodexAppServerSessionManager(binary), directory }
}

async function waitForPending(manager: CodexAppServerSessionManager, session: NativeSessionReference) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const pending = await manager.pending(session)
    if (pending) return pending
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('pending interaction was not observed')
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { await access(path); return } catch { await new Promise((resolve) => setTimeout(resolve, 5)) }
  }
  throw new Error(`expected child exit marker at ${path}`)
}

describe.skipIf(process.platform === 'win32')('Codex 0.154.0 app-server manager', () => {
  it('qualifies exact version/auth, correlates approval options, and delivers the exact response', async () => {
    const { manager, directory } = await fixture()
    const capabilities = await manager.capabilities()
    expect(capabilities).toMatchObject({ providerVersion: 'codex-cli 0.154.0', sameRequestResponses: true })
    expect(await manager.qualificationEvidence()).toMatchObject({
      providerVersion: 'codex-cli 0.154.0', authentication: 'chatgpt', productionSupported: false,
    })
    expect(await manager.inspectMcpConfiguration(directory)).toMatchObject({
      cwd: directory,
      configured: {
        enabled: true, required: true, transport: 'streamable_http',
        bearerTokenEnvironmentVariable: 'GRAPHQL_APP_MCP_TOKEN',
        enabledTools: ['context_get'], disabledTools: ['interaction_respond'],
      },
    })
    const session = await manager.createSession({
      request: request(directory), environment: {
        agentId: 'agent-a', variables: { TEST_AGENT_ID: 'agent-a', GRAPHQL_APP_MCP_TOKEN: 'secret-a' },
      },
    })
    const events = (async () => {
      const values = []
      for await (const event of manager.startTurn(session, { prompt: 'approve', clientCorrelationId: 'correlation-1' })) values.push(event)
      return values
    })()
    const pending = await waitForPending(manager, session)
    expect(pending.nativeRequestType).toBe('item/commandExecution/requestApproval')
    expect(pending.turn.nativeRequestId).toContain('commandExecution')
    const sessionOption = pending.responseOptions.find((option) => option.semantic === 'allow_session')
    expect(sessionOption?.label).toBe('Allow for this session')
    await expect(manager.respond(session, pending.turn.nativeRequestId!, { ...sessionOption!, optionId: 'forged' })).rejects.toMatchObject({
      result: { error: { code: 'NATIVE_RESPONSE_OPTION_INVALID' } },
    })
    await manager.respond(session, pending.turn.nativeRequestId!, sessionOption!)
    await events
    expect(await manager.history(session)).toMatchObject({ terminalResult: { outcome: 'succeeded', output: { text: 'approved-agent-a' } } })
    await manager.close(session)
  })

  it('keeps Agent environments isolated, continues a thread, inspects config/MCP, and cancels addressed turns', async () => {
    const { manager, directory } = await fixture()
    const sessionA = await manager.createSession({
      request: request(directory, 'agent-a'), environment: { agentId: 'agent-a', variables: { TEST_AGENT_ID: 'agent-a', GRAPHQL_APP_MCP_TOKEN: 'secret-a' } },
    })
    const sessionB = await manager.createSession({
      request: request(directory, 'agent-b'), environment: { agentId: 'agent-b', variables: { TEST_AGENT_ID: 'agent-b', GRAPHQL_APP_MCP_TOKEN: 'secret-b' } },
    })
    expect(sessionA.nativeSessionId).toBe('thread-agent-a')
    expect(sessionB.nativeSessionId).toBe('thread-agent-b')
    expect(await manager.inspectConfiguration(sessionA)).toMatchObject({ config: { approval_policy: 'on-request' } })
    expect(await manager.inspectNativeMcp(sessionA)).toMatchObject({ data: [{ name: 'graphql-app', runtimeStatus: 'connected', toolsError: null }] })
    expect(await manager.listNativeModels(sessionA)).toMatchObject({ data: [{ id: 'test-model' }] })
    await manager.reloadNativeMcp(sessionA)
    expect(await manager.startDeviceCodeLogin(sessionA)).toMatchObject({ type: 'chatgptDeviceCode', loginId: 'login-1' })
    await manager.cancelLogin(sessionA, 'login-1')
    for await (const event of manager.startTurn(sessionA, { prompt: 'complete', clientCorrelationId: 'a-1' })) void event
    const completedHistory = await manager.history(sessionA)
    expect(completedHistory.terminalResult?.output).toEqual({ text: 'answer-agent-a' })
    expect(completedHistory.events.filter((event) => event.type === 'item.completed')).toHaveLength(1)
    expect(completedHistory.events.some((event) => event.type === 'native.notification'
      && event.payload.nativeMethod === 'protocol/newNotification')).toBe(true)
    const canceled = (async () => {
      for await (const event of manager.startTurn(sessionA, { prompt: 'cancel me', clientCorrelationId: 'a-2' })) void event
    })()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(await manager.cancel(sessionA)).toBe(true)
    await canceled
    expect((await manager.history(sessionA)).terminalResult?.outcome).toBe('canceled')
    await expect(manager.refreshProcessEnvironment(sessionA, {
      agentId: 'agent-b', variables: { TEST_AGENT_ID: 'agent-b' },
    })).rejects.toMatchObject({ result: { error: { code: 'CODEX_SESSION_OWNER_MISMATCH' } } })
    await manager.refreshProcessEnvironment(sessionA, {
      agentId: 'agent-a', variables: { TEST_AGENT_ID: 'agent-a', GRAPHQL_APP_MCP_TOKEN: 'replacement-a' },
    })
    expect((await manager.history(sessionA)).events.some((event) => event.type === 'transport.environment_refreshed')).toBe(true)
    await Promise.all([manager.close(sessionA), manager.close(sessionB)])
  })

  it('restarts a lost transport for read-only reconciliation without replaying a turn', async () => {
    const { manager, directory } = await fixture()
    const session = await manager.createSession({
      request: request(directory), environment: {
        agentId: 'agent-a', variables: { TEST_AGENT_ID: 'agent-a', GRAPHQL_APP_MCP_TOKEN: 'secret-a' },
      },
    })
    for await (const event of manager.startTurn(session, { prompt: 'crash', clientCorrelationId: 'crash-1' })) void event
    const history = await manager.reconcile(session, 'reconcile-1')
    expect(history.events.some((event) => event.type === 'thread.reconciled' && event.payload.restarted === true)).toBe(true)
    await manager.close(session)
  })

  it('fails closed before spawn for missing or cross-Agent scoped credentials', async () => {
    const { manager, directory } = await fixture()
    await expect(manager.createSession({
      request: request(directory, 'agent-a'),
      environment: { agentId: 'agent-b', variables: { GRAPHQL_APP_MCP_TOKEN: 'secret-b' } },
    })).rejects.toMatchObject({ result: { error: { code: 'CODEX_SESSION_OWNER_MISMATCH' } } })
    await expect(manager.createSession({ request: request(directory, 'agent-a') })).rejects.toMatchObject({
      result: { error: { code: 'CODEX_SCOPED_ENVIRONMENT_REQUIRED' } },
    })
  })

  it('attaches only the exact persisted thread and never creates a replacement identity', async () => {
    const { manager, directory } = await fixture()
    const input = {
      request: request(directory, 'agent-a'),
      environment: {
        agentId: 'agent-a', variables: { TEST_AGENT_ID: 'agent-a', GRAPHQL_APP_MCP_TOKEN: 'secret-a' },
      },
    } as const
    const session = await manager.createSession(input)
    await manager.close(session)
    const restored = new CodexAppServerSessionManager(join(directory, 'codex.cjs'))
    expect(await restored.attachSession(session, input)).toEqual(session)
    expect((await restored.history(session)).events.some((event) => event.type === 'thread.attached')).toBe(true)
    await restored.close(session)

    const missing = { ...session, nativeSessionId: 'missing-thread' }
    await expect(restored.attachSession(missing, input)).rejects.toMatchObject({
      result: { error: { code: 'CODEX_SESSION_ID_MISMATCH' } },
    })
    await expect(restored.history(missing)).rejects.toMatchObject({
      result: { error: { code: 'CODEX_SESSION_UNAVAILABLE' } },
    })
  })

  it('closes fresh transports and registers no runtime when thread start or resume fails', async () => {
    const { manager, directory } = await fixture()
    const startMarker = join(directory, 'failed-start-exited')
    const baseVariables = { TEST_AGENT_ID: 'agent-a', GRAPHQL_APP_MCP_TOKEN: 'secret-a' }
    await expect(manager.createSession({
      request: request(directory, 'agent-a'),
      environment: {
        agentId: 'agent-a',
        variables: { ...baseVariables, TEST_FAIL_THREAD_START: '1', TEST_EXIT_MARKER: startMarker },
      },
    })).rejects.toMatchObject({ result: { error: { code: 'CODEX_APP_SERVER_REQUEST_FAILED' } } })
    await waitForFile(startMarker)
    await expect(manager.history({
      harness: 'codex', providerVersion: 'codex-cli 0.154.0', nativeSessionId: 'thread-agent-a',
    })).rejects.toMatchObject({ result: { error: { code: 'CODEX_SESSION_UNAVAILABLE' } } })

    const live = await manager.createSession({
      request: request(directory, 'agent-a'), environment: { agentId: 'agent-a', variables: baseVariables },
    })
    await manager.close(live)
    const resumeMarker = join(directory, 'failed-resume-exited')
    const restored = new CodexAppServerSessionManager(join(directory, 'codex.cjs'))
    await expect(restored.attachSession(live, {
      request: request(directory, 'agent-a'),
      environment: {
        agentId: 'agent-a',
        variables: { ...baseVariables, TEST_FAIL_THREAD_RESUME: '1', TEST_EXIT_MARKER: resumeMarker },
      },
    })).rejects.toMatchObject({ result: { error: { code: 'CODEX_APP_SERVER_REQUEST_FAILED' } } })
    await waitForFile(resumeMarker)
    await expect(restored.history(live)).rejects.toMatchObject({
      result: { error: { code: 'CODEX_SESSION_UNAVAILABLE' } },
    })
  })
})
