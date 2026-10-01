import type { OpenCodeMessage } from './opencodeProtocol.js'

export interface OpenCodePermissionIdentity {
  id: string
  sessionID: string
  tool?: { messageID: string }
}

/** A tool ask names its assistant message, not the submitted user turn. Only
 * the exact root session's proven direct parent may change that turn identity.
 * Descendant asking sessions stay intact; ancestry ownership alone is not proof
 * that the child assistant belongs to the root's submitted user message.
 */
export function openCodePermissionTurnId(request: OpenCodePermissionIdentity,
  root: { nativeSessionId: string; nativeTurnId: string } | undefined,
  message: OpenCodeMessage | undefined): string {
  const original = request.tool?.messageID ?? request.id
  if (!root || !request.tool || request.sessionID !== root.nativeSessionId) return original
  const info = message?.info
  return info?.id === request.tool.messageID && info.role === 'assistant'
    && info.sessionID === root.nativeSessionId && info.parentID === root.nativeTurnId
    ? root.nativeTurnId : original
}
