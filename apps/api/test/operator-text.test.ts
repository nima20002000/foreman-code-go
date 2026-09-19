import { describe, expect, it } from 'vitest'
import { nativeAssistantText } from '../src/modules/conversations/operatorText.js'

describe('operator thinking presentation', () => {
  it('keeps provider reasoning summaries separate from assistant response text', () => {
    expect(nativeAssistantText({ sequence: 1, type: 'native.notification', occurredAt: new Date().toISOString(),
      payload: { nativeMethod: 'item/reasoning/summaryTextDelta', itemId: 'r1', delta: 'Checking the arithmetic.' } }))
      .toEqual([{ partId: 'thinking:r1', text: 'Checking the arithmetic.', mode: 'append' }])
    expect(nativeAssistantText({ sequence: 2, type: 'message.part.updated', occurredAt: new Date().toISOString(),
      payload: { part: { id: 'r2', type: 'reasoning', text: 'Checking the result.' } } }))
      .toEqual([{ partId: 'thinking:r2', text: 'Checking the result.', mode: 'replace' }])
  })
})
