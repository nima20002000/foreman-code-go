import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { it } from 'vitest'
import { nativeMessageId, object } from '../src/modules/harnesses/opencodeProtocol.js'
import { ManagedOpenCodeServer, OpenCodeNativeSessionManager } from '../src/modules/harnesses/opencodeServer.js'
import { nativeConfigurationFixture, nativeJson, nativePrompt } from './support/opencodeNativeConfiguration.js'

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

it('isolates persisted native media by conversation while retaining imported forks and restart history', async () => {
  const f = await nativeConfigurationFixture({ files: true })
  await mkdir(f.vault, { mode: 0o700 })
  const allocate = (conversationId: string) => f.allocateChat(f.directory, 'agent-1', server => {
    server.bindFileConversation!(conversationId)
    return { async resolve() { throw new Error('This test submits media through the native HTTP interface.') } }
  })
  const media = 'data:image/png;base64,'
    + 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQMnb5DwACrQGZOt75egAAAABJRU5ErkJggg=='
  const legacy = new ManagedOpenCodeServer({ binary: process.env.OPENCODE_BINARY ?? 'opencode',
    workingDirectory: f.directory, ownerAgentId: 'agent-1', appMcpAccess: 'none', pure: true })
  const run = { server: legacy, native: new OpenCodeNativeSessionManager({ server: legacy,
    ownerAgentId: 'agent-1', appMcpAccess: 'none' }) }
  try {
    const source = await run.native.createSession(f.start())
    await nativeJson(run.server, f.directory, `/session/${source.nativeSessionId}/message`, {
      ...nativePrompt('run-media', 'parent', 'Source with media'), agent: 'parent',
      parts: [{ type: 'text', text: 'Source with media' },
        { type: 'file', mime: 'image/png', filename: 'source.png', url: media }],
    })
    const original = await nativeJson(run.server, f.directory,
      `/session/${source.nativeSessionId}/message/${nativeMessageId('run-media')}`)
    assert((original.parts as Record<string, unknown>[]).some(part => part.url === media))
    const ownerA = allocate('conversation-a')
    const fork = await ownerA.native.forkSession(source, f.start())
    const ownerB = allocate('conversation-b')
    const other = await ownerB.native.createSession(f.start())
    await nativeJson(ownerB.server, f.directory, `/session/${other.nativeSessionId}/message`, {
      ...nativePrompt('other-media', 'parent', 'Other media'), agent: 'parent',
      parts: [{ type: 'text', text: 'Other media' },
        { type: 'file', mime: 'image/png', filename: 'other.png', url: media }],
    })
    const ownDatabase = join(ownerA.server.ownedSessionRoot!, 'data', 'opencode', 'opencode.db')
    const foreignDatabase = join(ownerB.server.ownedSessionRoot!, 'data', 'opencode', 'opencode.db')
    const legacyDatabase = join(process.env.XDG_DATA_HOME!, 'opencode', 'opencode.db')
    for (const database of [ownDatabase, foreignDatabase, legacyDatabase]) {
      const stored = new DatabaseSync(database, { readOnly: true })
      try {
        assert(stored.prepare('select data from part').all().some(row => String(row.data).includes(media)))
      } finally {
        stored.close()
      }
    }
    const program = `
      const fs = require('node:fs')
      const assert = require('node:assert/strict')
      const [own, foreign, legacy] = process.argv.slice(1)
      assert(fs.readFileSync(own).length > 0)
      for (const path of [foreign, legacy]) {
        assert.throws(() => fs.readFileSync(path), { code: 'ENOENT' })
        assert.throws(() => fs.writeFileSync(path, 'tampered'), { code: 'ENOENT' })
      }
      console.log('isolated-storage-ok')
    `
    const result = await nativeJson(ownerA.server, f.directory, `/session/${fork.nativeSessionId}/shell`, {
      agent: 'parent', command: [process.execPath, '-e', program, ownDatabase, foreignDatabase, legacyDatabase]
        .map(quote).join(' '),
    })
    assert((result.parts as Record<string, unknown>[]).some(part =>
      String(object(part.state).output).includes('isolated-storage-ok')))
    const foreign = await ownerA.server.request(`/session/${other.nativeSessionId}?directory=${encodeURIComponent(f.directory)}`)
    assert.equal(foreign.status, 404)
    await ownerA.native.dispose()
    const restarted = allocate('conversation-a')
    assert.deepEqual(await restarted.native.attachSession(fork, f.start()), fork)
    const history = await restarted.server.request(`/session/${fork.nativeSessionId}/message?limit=100`
      + `&directory=${encodeURIComponent(f.directory)}`)
    assert((await history.json() as { parts: Record<string, unknown>[] }[])
      .some(message => message.parts.some(part => part.url === media)))
    const preserved = await nativeJson(run.server, f.directory,
      `/session/${source.nativeSessionId}/message/${nativeMessageId('run-media')}`)
    assert.deepEqual(preserved, original)
    const otherStored = await nativeJson(ownerB.server, f.directory,
      `/session/${other.nativeSessionId}/message/${nativeMessageId('other-media')}`)
    assert((otherStored.parts as Record<string, unknown>[]).some(part => part.url === media))
  } finally {
    try { await run.native.dispose() } finally { await f.close() }
  }
}, 120_000)
