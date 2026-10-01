import assert from 'node:assert/strict'
import { it } from 'vitest'
import { NativeResponseJournal } from '../src/modules/harnesses/recovery/responseJournal.js'
import { OpenCodeNativeDeliveryError, OpenCodeNativeSessionManager } from '../src/modules/harnesses/opencodeServer.js'
import { FixtureServer, permission, sessionFor } from './opencode-fixtures.js'

it('keeps exact HTTP reply accepted when durable journal commit fails, without resending', async () => {
  const server = new FixtureServer()
  const journal = new NativeResponseJournal('/unused-injected-journal')
  journal.record = () => { throw new Error('injected journal commit failure') }
  const native = new OpenCodeNativeSessionManager({ server, ownerAgentId: 'agent-1', appMcpServerName: 'graphql', responseJournal: journal })
  try {
    const session = await sessionFor(native)
    server.permissions = [permission('journal_reply')]
    server.beforeRequest = path => {
      if (path.includes('/permission/journal_reply/reply')) server.emit('permission.replied', {
        sessionID: session.nativeSessionId, requestID: 'journal_reply', reply: 'once',
      })
      return undefined
    }
    const option = (await native.pending(session))!.responseOptions[0]!
    await assert.rejects(native.respond(session, 'journal_reply', option), error => {
      assert(error instanceof OpenCodeNativeDeliveryError)
      assert.equal(error.certainty, 'uncertain')
      assert.equal(error.code, 'OPENCODE_PERMISSION_JOURNAL_UNCERTAIN')
      return true
    })
    await assert.rejects(native.respond(session, 'journal_reply', option))
    assert.equal(server.calls.filter(call => call.path.includes('/permission/journal_reply/reply')).length, 1)
  } finally { await native.dispose() }
})
