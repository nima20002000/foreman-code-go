import { expect, it } from 'vitest'
import { OpenCodeFileTurn } from '../src/modules/harnesses/opencodeFiles/turn.js'
import type { AcceptedOpenCodeFileTurn } from '../src/modules/harnesses/opencodeFiles/types.js'
import { FixtureServer } from './opencode-fixtures.js'
import { createChatFileBackend, fileContext, fileSignal } from './support/opencodeChatFileFixture.js'

it.each([
  { name: 'foreman-code', connected: true, collision: false, accepted: true },
  { name: 'graphql', connected: true, collision: false, accepted: true },
  { name: 'graphql', connected: false, collision: false, accepted: false },
  { name: 'foreman-code', connected: true, collision: true, accepted: false },
])('prepares Operator file inputs only with one connected supported management entry: %j', async scenario => {
  const backend = createChatFileBackend()
  const server = new FixtureServer()
  server.config = { mcp: { [scenario.name]: { enabled: true },
    ...(scenario.collision ? { graphql: { enabled: true } } : {}) } }
  server.mcp = { [scenario.name]: { status: scenario.connected ? 'connected' : 'failed' },
    ...(scenario.collision ? { graphql: { status: 'connected' } } : {}) }
  const context = fileContext({ allowMutation: false, scope: { kind: 'temporary', chat: {
    kind: 'operator', operatorId: 'application-operator', conversationId: 'operator-conversation',
    ownerPrincipalId: 'human-a',
  } } })
  const admission: AcceptedOpenCodeFileTurn = { context, attachments: [], mode: 'read',
    executionHostId: 'execution-b', directory: '/operator', expiresAt: new Date(Date.now() + 60_000) }
  const turn = new OpenCodeFileTurn({ service: backend.service, host: backend.host, server,
    endpoint: 'http://127.0.0.1:9876/mcp/files', appMcpServerName: 'foreman-code',
    maxFileBytes: 1024, maxAttachments: 10, adoptPublished: backend.adoptPublished })
  try {
    const prepare = turn.prepareInputs(admission, backend.readAccepted(context), fileSignal())
    if (scenario.accepted) await expect(prepare).resolves.toMatchObject({ imageParts: [] })
    else await expect(prepare).rejects.toMatchObject({
      code: scenario.collision ? 'FILE_TURN_SETUP_FAILED' : 'FILE_CHAT_ISOLATION_REQUIRED',
    })
    expect(backend.issued).toHaveLength(0)
    expect(server.calls.filter(call => call.method === 'POST')).toHaveLength(0)
  } finally {
    await turn.finish('definite_rejection', fileSignal())
    await server.dispose()
  }
})
