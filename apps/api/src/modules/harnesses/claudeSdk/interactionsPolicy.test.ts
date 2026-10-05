import { expect, it, vi } from 'vitest'
import type { HookInput } from '@anthropic-ai/claude-agent-sdk'
import type { ClaudeHarnessConfiguration } from '@graphql/contracts/claude'
import { ClaudeInteractionBridge, type ClaudeCallbackIdentity } from './interactions.js'
import { createClaudeSdkCallbacks } from './sdkCallbacks.js'
import type { ClaudeNativeSessionManager } from './sessionManager.js'

const tool = 'mcp__graphql__workspace_list'
const configuration: ClaudeHarnessConfiguration = {
  harness: 'claude', model: 'fixture', authMode: 'subscription', configDirectory: '/profile',
  permissionMode: 'default', sandbox: 'read-only', tools: [tool], permissionRules: [], instructions: '',
  mcpServers: { graphql: { type: 'http', url: 'http://127.0.0.1/mcp' } },
}
const session = { harness: 'claude' as const, providerVersion: '2.1.284', nativeSessionId: 'session' }
const identity: ClaudeCallbackIdentity = {
  ownerPrincipalId: 'owner', nativeSessionId: session.nativeSessionId, nativeMessageId: 'message',
  clientCorrelationId: 'correlation', attemptId: 'request', generation: 'generation', toolUseId: 'tool',
  nativeRequestId: 'permission', nativeRequestType: 'can_use_tool', mcpServer: { name: 'graphql', source: 'dynamic' },
}
function fixture(accepted = configuration) {
  const validate = vi.fn(async () => {})
  const persisted = vi.fn(async () => false)
  const bridge: ClaudeInteractionBridge = new ClaudeInteractionBridge(accepted, {
    validate, validateResponse: validate, request: value => bridge.waitForResponse(value), deliveryPersisted: persisted,
  })
  bridge.bindMcpTools([{ serverName: 'graphql', source: { kind: 'http', url: configuration.mcpServers.graphql!.url },
    tools: ['workspace_list', 'workspace_create'] }])
  return { bridge, validate, persisted }
}

it.each(['allow', 'ask', 'deny'] as const)('enforces the saved MCP %s effect after manifest and current authority checks', async effect => {
  const f = fixture({ ...configuration, permissionRules: [{ tool, effect }] })
  try {
    const preflight = await f.bridge.beforeToolUse(identity, tool, {})
    expect(preflight.permissionDecision).toBe(effect === 'allow' ? undefined : effect)
    const decision = f.bridge.canUseTool(identity, tool, {}, new AbortController().signal)
    if (effect === 'ask') {
      await vi.waitFor(() => expect(f.bridge.pendingInteractions(session)).toHaveLength(1))
      await f.bridge.respond(session, identity.nativeRequestId!, f.bridge.pendingInteractions(session)[0]!.responseOptions[0]!)
    }
    expect((await decision).behavior).toBe(effect === 'deny' ? 'deny' : 'allow')
    expect(f.validate).toHaveBeenCalled()
  } finally { f.bridge.close() }
})

it('does not admit a discovered tool omitted from the saved enabled list or a foreign source', async () => {
  const f = fixture()
  expect(await f.bridge.beforeToolUse(identity, 'mcp__graphql__workspace_create', {}))
    .toMatchObject({ permissionDecision: 'deny' })
  expect((await f.bridge.canUseTool(identity, 'mcp__graphql__workspace_create', {}, new AbortController().signal)).behavior).toBe('deny')
  expect(await f.bridge.beforeToolUse({ ...identity, mcpServer: { name: 'graphql', source: 'user' } }, tool, {}))
    .toMatchObject({ permissionDecision: 'deny' })
  expect(f.bridge.pendingInteractions(session)).toEqual([])
})

it.each([
  { selected: 'allow_once', event: 'PostToolUseFailure', outcome: 'failed', semantic: 'approve_once' },
  { selected: 'cancel', event: 'PermissionDenied', outcome: 'permission_denied', semantic: 'cancel' },
] as const)('acknowledges $selected only after qualified $event consumption', async ({ selected, event, semantic }) => {
  const f = fixture()
  try {
    const decision = f.bridge.canUseTool(identity, tool, {}, new AbortController().signal)
    await vi.waitFor(() => expect(f.bridge.pendingInteractions(session)).toHaveLength(1))
    const option = f.bridge.pendingInteractions(session)[0]!.responseOptions.find(value => value.optionId === selected)!
    await f.bridge.respond(session, identity.nativeRequestId!, option)
    expect(await decision).toMatchObject(selected === 'cancel' ? { behavior: 'deny', interrupt: true } : { behavior: 'allow' })
    expect(f.bridge.deliveryEvidence(session)).toEqual([])
    const callbacks = createClaudeSdkCallbacks({ manager: () => ({
      waitNativeCallbackContext: async () => ({ ...identity }),
      callbackAuthority: () => ({ ownerPrincipalId: identity.ownerPrincipalId, attemptId: identity.attemptId }),
    }) as unknown as ClaudeNativeSessionManager, bridge: f.bridge })
    const hook = callbacks.hooks![event]![0]!.hooks[0]!
    await hook({ hook_event_name: event, session_id: session.nativeSessionId, transcript_path: '/transcript', cwd: '/work',
      tool_use_id: identity.toolUseId, tool_name: tool, mcp_server: identity.mcpServer,
      ...(event === 'PostToolUseFailure' ? { tool_input: {}, error: 'tool failed', is_interrupt: false }
        : { tool_input: {}, permission_suggestions: [] }),
    } as HookInput, identity.toolUseId, { signal: new AbortController().signal })
    expect(f.bridge.deliveryEvidence(session)).toMatchObject([{ optionId: selected, semantic }])
  } finally { f.bridge.close() }
})

it('retires persisted delivery records and still refuses old callbacks with changed input', async () => {
  const f = fixture()
  try {
    for (let index = 0; index < 300; index++) {
      const callback = { ...identity, toolUseId: `tool-${index}`, nativeRequestId: `permission-${index}` }
      const decision = f.bridge.canUseTool(callback, tool, { index }, new AbortController().signal)
      await vi.waitFor(() => expect(f.bridge.pendingInteractions(session)).toHaveLength(1))
      await f.bridge.respond(session, callback.nativeRequestId, f.bridge.pendingInteractions(session)[0]!.responseOptions[0]!)
      expect((await decision).behavior).toBe('allow')
      await f.bridge.observeToolResult(callback, tool, 'executed')
      f.persisted.mockResolvedValue(true)
    }
    const first = { ...identity, toolUseId: 'tool-0', nativeRequestId: 'permission-0' }
    expect((await f.bridge.canUseTool(first, tool, { index: 0 }, new AbortController().signal)).behavior).toBe('deny')
    await expect(f.bridge.canUseTool(first, tool, { index: 1 }, new AbortController().signal)).rejects.toThrow('different input')
    expect(f.bridge.deliveryEvidence(session)).toHaveLength(0)
    expect(f.bridge.inspectCallbackAvailability({ ...first, nativeMessageId: 'message', generation: 'generation', nativeRequestType: 'can_use_tool' })).toMatchObject({ reason: 'request_consumed' })
    expect(f.persisted).toHaveBeenCalled()
  } finally { f.bridge.close() }
}, 30_000)
