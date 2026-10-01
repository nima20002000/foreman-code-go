import assert from 'node:assert/strict'
import { it } from 'vitest'
import { isOpenCodeReplyAcknowledgement } from '../src/modules/harnesses/openCodeResponseAcknowledgement.js'

it('requires the actual asking session, request identity and exact reply option', () => {
  const event = { type: 'permission.replied', properties: { sessionID: 'child', requestID: 'request', reply: 'once' } }
  assert.equal(isOpenCodeReplyAcknowledgement(event, 'child', 'request', 'once'), true)
  assert.equal(isOpenCodeReplyAcknowledgement(event, 'root', 'request', 'once'), false)
  assert.equal(isOpenCodeReplyAcknowledgement(event, 'child', 'reused-request', 'once'), false)
  assert.equal(isOpenCodeReplyAcknowledgement(event, 'child', 'request', 'always'), false)
  assert.equal(isOpenCodeReplyAcknowledgement({ ...event, type: 'permission.asked' }, 'child', 'request', 'once'), false)
  assert.equal(isOpenCodeReplyAcknowledgement({ type: 'permission.replied', properties: {
    sessionID: '', requestID: '', reply: 'once',
  } }, '', '', 'once'), false)
})
