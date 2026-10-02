import { randomUUID } from 'node:crypto'
import { chmod, mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { openPrivateRoot, identity } from '../src/modules/sources/privateFilesystem.js'
import { qualifyApprovedRootAllowlist, attestWorkspaceRoot } from '../src/modules/sources/rootAttestation.js'
import { workspaceRootDirectory } from './helpers/workspaceRootDirectory.js'

it('keeps root fixtures private with genuine filesystem identities despite an unsafe TMPDIR', async () => {
  const directory = await workspaceRootDirectory()
  try {
    const unsafe = join(directory, 'scheduler-temp'), rejected = join(unsafe, 'private-leaf')
    await mkdir(unsafe, { mode: 0o775 }); await chmod(unsafe, 0o775)
    await mkdir(rejected, { mode: 0o700 })
    await expect(openPrivateRoot(rejected)).rejects.toMatchObject({ code: 'SOURCE_FILESYSTEM_UNSUPPORTED' })
    vi.stubEnv('TMPDIR', unsafe)
    const fixture = await workspaceRootDirectory()
    try {
      expect(fixture.startsWith('/tmp/w08-workspace-root-')).toBe(true)
      expect(fixture.startsWith(unsafe)).toBe(false)
      const metadata = await stat(fixture)
      expect(metadata.uid).toBe(process.getuid!())
      expect(metadata.mode & 0o777).toBe(0o700)
      for (const name of ['approved-base', 'root-runtime']) {
        const path = join(fixture, name)
        await mkdir(path, { mode: 0o700 })
        const handle = await openPrivateRoot(path)
        try { expect(await identity(handle)).toMatchObject({ device: expect.any(String), inode: expect.any(String), mountId: expect.stringMatching(/^\d+$/) }) }
        finally { await handle.close() }
      }
      const basePath = join(fixture, 'approved-base'), runtimePath = join(fixture, 'root-runtime')
      await mkdir(join(basePath, 'project'), { mode: 0o700 })
      const mainId = randomUUID(), baseId = randomUUID()
      const allowlist = await qualifyApprovedRootAllowlist({ schemaVersion: 1, hostRef: { kind: 'main', mainId },
        applicationInstallationId: mainId, configurationRevision: '1',
        bases: [{ baseId, canonicalPath: basePath, accessModes: ['read-only', 'read-write'] }], managedRuntimeRoot: runtimePath })
      const attestation = await attestWorkspaceRoot(allowlist, { workspaceId: randomUUID(), hostRef: allowlist.hostRef,
        allowedBaseId: baseId, configurationRevision: '1', relativePath: 'project', accessMode: 'read-only',
        expectedLocationRevision: 0, expectedRootPolicyRevision: 0 })
      expect(attestation.canonicalProjectRoot).toBe(join(basePath, 'project'))
      expect(attestation.runtimeFilesystem).toEqual(allowlist.runtimeFilesystem)
    } finally { await rm(fixture, { recursive: true, force: true }) }
  } finally { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }) }
})
