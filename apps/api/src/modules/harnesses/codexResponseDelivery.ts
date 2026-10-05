import { canonicalGraphJson } from '@graphql/contracts/wave25'
import type { ApprovalResponseOption, PendingNativeInteraction } from '@graphql/contracts'
import { responseValueDigest, type NativeResponseDeliveryEvidence } from '../interactions/delivery.js'
import type { NativeHistory } from './port.js'
import { isObject, type JsonObject } from './codexStdioTransport.js'

/** Resolution can also mean cancellation. Verify consumption through a result or an unchanged native turn read. */
export function codexInputDeliveryEvidence(pending: PendingNativeInteraction, option: ApprovalResponseOption,
  nativeResponse: JsonObject, history: NativeHistory): NativeResponseDeliveryEvidence | undefined {
  const request = pending.request
  if (!isObject(request) || !['item/tool/requestUserInput', 'mcpServer/elicitation/request']
    .includes(pending.nativeRequestType)) return undefined
  const requestId = pending.turn.nativeRequestId
  const events = history.events
  const submitted = events.find(event => event.type === 'interaction.submitted'
    && event.payload.nativeRequestId === requestId && event.payload.optionId === option.optionId
    && event.payload.semantic === option.semantic
    && event.payload.responseDigest === responseValueDigest(option.response))
  if (!submitted?.connectionId) return undefined
  const reserved = events.find(event => event.connectionId === submitted.connectionId
    && event.type === 'interaction.submitting' && event.payload.nativeRequestId === requestId
    && event.sequence < submitted.sequence)
  const resolved = events.find(event => event.connectionId === submitted.connectionId
    && event.type === 'interaction.resolved' && event.payload.nativeRequestId === requestId
    && event.payload.submittedOptionId === option.optionId && reserved && event.sequence > reserved.sequence)
  if (!reserved || !resolved) return undefined
  const completed = events.filter(event => event.connectionId === submitted.connectionId
    && event.sequence > resolved.sequence && ['item.completed', 'item.snapshot'].includes(event.type)
    && event.payload.threadId === pending.session.nativeSessionId
    && event.payload.turnId === pending.turn.nativeTurnId)
  let consumed = false
  if (pending.nativeRequestType === 'item/tool/requestUserInput') {
    consumed = completed.some(event => {
      const item = event.payload.item
      if (!isObject(item) || item.type !== 'functionCallOutput' || item.id !== request.itemId
        || item.name !== 'request_user_input') return false
      let output = item.output
      if (Array.isArray(output) && output.length === 1 && isObject(output[0])
        && output[0].type === 'input_text') output = output[0].text
      if (typeof output !== 'string') return false
      try { return canonicalGraphJson(JSON.parse(output)) === canonicalGraphJson(nativeResponse) }
      catch { return false }
    })
  } else {
    const started = events.filter(event => event.connectionId === submitted.connectionId
      && event.sequence < reserved.sequence && event.type === 'item.started'
      && event.payload.threadId === pending.session.nativeSessionId
      && event.payload.turnId === pending.turn.nativeTurnId && isObject(event.payload.item)
      && event.payload.item.type === 'mcpToolCall' && event.payload.item.server === request.serverName)
      .filter(event => !events.some(other => other.type === 'item.completed' && other.sequence < reserved.sequence
        && other.connectionId === event.connectionId && isObject(other.payload.item) && isObject(event.payload.item)
        && other.payload.item.id === event.payload.item.id))
    consumed = started.length === 1 && completed.some(event => {
      const item = event.payload.item
      const original = started[0]!.payload.item
      return isObject(item) && isObject(original) && item.id === original.id && item.type === 'mcpToolCall'
        && item.server === request.serverName && item.status === 'completed' && item.result != null && !item.error
    })
    const offered = events.find(event => event.connectionId === submitted.connectionId
      && event.type === 'interaction.pending' && event.payload.nativeRequestId === requestId
      && event.sequence < reserved.sequence)
    consumed ||= Boolean(offered && events.some(event => event.connectionId === submitted.connectionId
      && event.type === 'interaction.readback' && event.payload.nativeRequestId === requestId
      && event.sequence > resolved.sequence && event.payload.threadId === pending.session.nativeSessionId
      && Object.hasOwn(offered.payload, 'observedTurnId') && Object.hasOwn(offered.payload, 'observedTurnStatus')
      && event.payload.observedTurnId === offered.payload.observedTurnId
      && event.payload.observedTurnStatus === offered.payload.observedTurnStatus))
  }
  if (!consumed) return undefined
  return { source: 'provider_history', ...pending.session, nativeRequestId: requestId!,
    nativeRequestType: pending.nativeRequestType, optionId: option.optionId, semantic: option.semantic,
    responseDigest: responseValueDigest(option.response) }
}
