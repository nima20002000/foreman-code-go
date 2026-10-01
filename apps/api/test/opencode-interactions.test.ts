import assert from 'node:assert/strict'
import { it } from 'vitest'
import { openCodePermissionTurnId } from '../src/modules/harnesses/opencodeInteractions.js'

it('rewrites only an exact root assistant with a proven direct submitted-user parent', () => {
  const root = { nativeSessionId: 'root', nativeTurnId: 'user' }
  const request = { id: 'approval', sessionID: 'root', tool: { messageID: 'assistant' } }
  const message = { info: { id: 'assistant', role: 'assistant', sessionID: 'root', parentID: 'user' }, parts: [] }
  assert.equal(openCodePermissionTurnId(request, root, message), 'user')
  assert.equal(openCodePermissionTurnId(request, root, undefined), 'assistant')
  assert.equal(openCodePermissionTurnId(request, undefined, message), 'assistant')
  for (const info of [
    { ...message.info, id: 'different' }, { ...message.info, role: 'user' },
    { ...message.info, sessionID: 'foreign' }, { ...message.info, parentID: 'different' },
  ]) assert.equal(openCodePermissionTurnId(request, root, { info, parts: [] }), 'assistant')
  assert.equal(openCodePermissionTurnId({ ...request, sessionID: 'child' }, root, message), 'assistant')
  assert.equal(openCodePermissionTurnId({ id: 'approval', sessionID: 'root' }, root, message), 'approval')
  assert.deepEqual(request, { id: 'approval', sessionID: 'root', tool: { messageID: 'assistant' } })
})
