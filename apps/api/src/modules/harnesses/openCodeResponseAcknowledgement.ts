import type { OpenCodeEvent } from './opencodeProtocol.js'

/** Both identities AND the exact native choice are required. Mere request disappearance is ignored. */
export function isOpenCodeReplyAcknowledgement(
  event: OpenCodeEvent, sessionID: string, requestID: string, reply: 'once' | 'always' | 'reject',
): boolean {
  return event.type === 'permission.replied' && event.properties?.sessionID === sessionID
    && event.properties.requestID === requestID && event.properties.reply === reply
}
