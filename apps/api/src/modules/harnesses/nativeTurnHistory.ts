import type { ExecutionResult } from '@foreman-code/contracts'

export type NativeObject = Record<string, unknown>
export function nativeObject(value: unknown): NativeObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as NativeObject : {}
}
function text(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined }
export interface AddressedNativeResult {
  correlationId: string
  nativeTurnId: string
  nativeMessageId?: string
  terminalResult?: ExecutionResult
}

/** Never select the last turn as a substitute for a missing request identity. */
export function addressedCodexTurn(thread: NativeObject, correlationId: string, nativeTurnId?: string): AddressedNativeResult | undefined {
  if (!Array.isArray(thread.turns)) return undefined
  const turns = thread.turns.map(nativeObject)
  const matches = turns.filter((turn) => {
    if (nativeTurnId) return turn.id === nativeTurnId
    if (turn.clientUserMessageId === correlationId) return true
    return Array.isArray(turn.items) && turn.items.some((value) => {
      const item = nativeObject(value)
      return item.type === 'userMessage' && (item.id === correlationId || item.clientUserMessageId === correlationId)
    })
  })
  if (matches.length !== 1 || typeof matches[0]!.id !== 'string') return undefined
  const turn = matches[0]!
  const id = turn.id as string
  const result: AddressedNativeResult = { correlationId, nativeTurnId: id }
  if (turn.status === 'interrupted') result.terminalResult = { outcome: 'canceled' }
  else if (turn.status === 'failed') result.terminalResult = { outcome: 'failed', error: {
    code: 'CODEX_TURN_FAILED', message: text(nativeObject(turn.error).message) ?? 'Codex turn failed.', retryable: false,
  } }
  else if (turn.status === 'completed') {
    const messages = (Array.isArray(turn.items) ? turn.items : []).map(nativeObject).filter((item) => item.type === 'agentMessage')
    const answer = [...messages].reverse().find((item) => item.phase === 'final_answer') ?? messages.at(-1)
    result.nativeMessageId = text(answer?.id) ?? `${id}:terminal`
    result.terminalResult = { outcome: 'succeeded', output: { text: text(answer?.text) ?? '' } }
  }
  return result
}
