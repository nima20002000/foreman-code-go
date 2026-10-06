import { privateFixtureDirectory } from './helpers/privateFixtureDirectory.js'
import { removeFixtureDirectory } from './helpers/testResources.js'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { FileByteStorage } from '../src/modules/files/storage.js'
import { IsolatedOpenCodeFixture } from './support/isolatedOpenCodeFixture.js'

it.each(['dispose', 'observation'] as const)('keeps the protocol fixture in real vault isolation through %s', async ending => {
  const directory = await privateFixtureDirectory('.operator-fixture-containment-')
  const workspace = join(directory, 'workspace')
  const vault = join(directory, 'vault')
  const server = new IsolatedOpenCodeFixture({ binary: 'protocol-fixture', workingDirectory: workspace,
    ownerAgentId: 'fixture-agent', protectedFileStorageRoot: vault, managedFileRoot: join(directory, 'copies') })
  try {
    await mkdir(workspace, { mode: 0o700 })
    await new FileByteStorage(vault, 1024).initialize()
    server.bindFileConversation('owned-conversation')
    expect(() => server.bindFileConversation('another-conversation')).toThrow('cannot change conversations')
    await server.ensure()
    expect(server.nativePid).toBeGreaterThan(0)
    await server.assertFileSourceIsolation(vault, AbortSignal.timeout(10_000))
    await expect(server.assertFileSourceIsolation(workspace, AbortSignal.timeout(10_000)))
      .rejects.toThrow('changed its protected vault')
    if (ending === 'observation') await server.startObservation()
    else await server.dispose()
    expect(server.nativePid).toBeUndefined()
  } finally {
    try { await server.dispose() }
    finally { await removeFixtureDirectory(directory) }
  }
}, 30_000)
