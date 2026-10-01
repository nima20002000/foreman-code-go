import type { CanUseTool, HookCallback, Options } from '@anthropic-ai/claude-agent-sdk'
import type { ClaudeNativeSessionManager } from './sessionManager.js'

/** The existing B bridge is injected, never replaced by another response/interaction store. */
export interface ClaudeSdkPolicyBridge {
  beforeToolUse(identity: {
    ownerPrincipalId: string; attemptId: string; nativeSessionId: string; nativeMessageId: string
    generation: string; toolUseId: string; agentId?: string
  }, toolName: string, input: Record<string, unknown>): Promise<{ permissionDecision?: 'deny' | 'ask'; permissionDecisionReason?: string }>
  canUseTool(identity: {
    ownerPrincipalId: string; attemptId: string; nativeSessionId: string; nativeMessageId: string
    generation: string; toolUseId: string; nativeRequestId: string; nativeRequestType: 'can_use_tool'; agentId?: string
  }, toolName: string, input: Record<string, unknown>, signal: AbortSignal): Promise<{ behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string; interrupt?: boolean }>
}

export function createClaudeSdkCallbacks(input: {
  manager(): ClaudeNativeSessionManager
  bridge: ClaudeSdkPolicyBridge
}): Pick<Options, 'canUseTool' | 'hooks'> {
  const canUseTool: CanUseTool = async (name, value, options) => {
    if (options.agentID) return { behavior: 'deny', message: 'Native child tool callbacks are not qualified.' }
    if (!options.requestId || !options.toolUseID) return { behavior: 'deny', message: 'Exact native control request identity is unavailable.' }
    try {
      const context = await input.manager().waitNativeCallbackContext(options.toolUseID, options.signal)
      const authority = input.manager().callbackAuthority(context)
      if (!authority) return { behavior: 'deny', message: 'No admitted message authority matches the native callback.' }
      return await input.bridge.canUseTool({ ...context, ...authority,
        toolUseId: options.toolUseID, nativeRequestId: options.requestId, nativeRequestType: 'can_use_tool' }, name, value, options.signal)
    } catch {
      return { behavior: 'deny', message: 'The admitted native callback context is unavailable.', interrupt: options.signal.aborted }
    }
  }
  const beforeToolUse: HookCallback = async (hook, suppliedToolId, options) => {
    const deny = { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const,
      permissionDecisionReason: 'The admitted native tool context is unavailable.' } }
    if (hook.hook_event_name !== 'PreToolUse' || !hook.tool_input || typeof hook.tool_input !== 'object' || Array.isArray(hook.tool_input) || !hook.tool_use_id || suppliedToolId && suppliedToolId !== hook.tool_use_id) return deny
    try {
      const context = await input.manager().waitNativeCallbackContext(hook.tool_use_id, options.signal, hook.session_id)
      const authority = input.manager().callbackAuthority(context)
      if (!authority) return deny
      const decision = await input.bridge.beforeToolUse({ ...context, ...authority, toolUseId: hook.tool_use_id }, hook.tool_name, hook.tool_input as Record<string, unknown>)
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', ...decision } }
    } catch { return deny }
  }
  return { canUseTool, hooks: { PreToolUse: [{ hooks: [beforeToolUse] }] } }
}
