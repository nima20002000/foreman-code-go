import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ApprovedRootAllowlistSchema } from '@foreman-code/contracts/workspace-root-policies'
import { installedConversationDirectory } from './installedConversationDirectory.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'
import { identity, openPrivateRoot } from '../sources/privateFilesystem.js'

it('uses the approved folder and rejects replacement of that folder or its root permission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'conversation-root-'))
  const base = join(root, 'base')
  const project = join(base, 'project')
  const runtime = join(root, 'runtime')
  const f = workerConversationFixture('agent')
  try {
    await mkdir(project, { recursive: true, mode: 0o700 })
    await mkdir(runtime, { mode: 0o700 })
    const baseHandle = await openPrivateRoot(base)
    const runtimeHandle = await openPrivateRoot(runtime)
    let roots
    try {
      roots = ApprovedRootAllowlistSchema.parse({ schemaVersion: 1, hostRef: f.binding.profile.target.hostRef,
        applicationInstallationId: f.connection.workerInstallationId, configurationRevision: '1',
        bases: [{ baseId: randomUUID(), canonicalPath: base, filesystem: await identity(baseHandle), accessModes: ['read-only'] }],
        managedRuntimeRoot: runtime, runtimeFilesystem: await identity(runtimeHandle) })
    } finally { await baseHandle.close(); await runtimeHandle.close() }
    const binding = { ...f.binding, workingDirectory: project }
    const directory = await installedConversationDirectory({ binding, configuration: f.configuration,
      approvedRoots: async () => roots })
    await directory.assertCurrent()
    await rename(project, join(base, 'original'))
    await mkdir(project, { mode: 0o700 })
    await expect(directory.assertCurrent()).rejects.toMatchObject({ code: 'WORKER_CONVERSATION_ROOT_CHANGED' })
    roots.bases[0]!.accessModes = ['read-write']
    await expect(directory.assertCurrent()).rejects.toMatchObject({ code: 'WORKER_CONVERSATION_ROOT_CHANGED' })
  } finally { await rm(root, { recursive: true, force: true }) }
})
