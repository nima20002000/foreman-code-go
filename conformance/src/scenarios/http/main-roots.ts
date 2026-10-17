import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { MainDeviceIdentityPublicSchema } from '@foreman-code/contracts/device-identity'
import { publicKeyFingerprint } from '@foreman-code/contracts/device-identity-node'
import { ApprovedRootAllowlistSchema } from '@foreman-code/contracts/workspace-root-policies'
import { assertResponse } from '../../assertions.js'
import type { ScenarioContext } from '../../scenario.js'
import { ownedFilesystem } from './owned-filesystem.js'

function mainStorageBaseId(mainId: string, storageRoot: string): string {
  const digest = createHash('sha256')
    .update(`graphql:main-workspace-storage:v1:${mainId}:${storageRoot}`).digest()
  const uuid = Buffer.from(digest.subarray(0, 16))
  uuid[6] = (uuid[6]! & 0x0f) | 0x50
  uuid[8] = (uuid[8]! & 0x3f) | 0x80
  const hex = uuid.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export async function readMainIdentity(ctx: ScenarioContext) {
  const response = await ctx.http.request('GET', '/api/devices/main')
  const main = MainDeviceIdentityPublicSchema.parse(response.body)
  assertResponse(response, { status: 200, body: {
    mainId: '<uuid>', mainPublicKey: main.mainPublicKey,
    mainPublicKeyFingerprint: publicKeyFingerprint(main.mainPublicKey),
  } }, [{ pointer: '/body/mainId', kind: 'uuid' }])
  return main
}

/** Expected installation bootstrap comes from launch configuration and actual owned OS fixtures. */
export async function mainRootConfiguration(ctx: ScenarioContext, mainId: string) {
  const storageRoot = ctx.target.environment.WORKSPACE_STORAGE_ROOT
  const managedRuntimeRoot = ctx.target.environment.HARNESS_WORKSPACE_ROOT
  assert.ok(storageRoot, 'The launcher must expose its app-managed workspace storage')
  assert.ok(managedRuntimeRoot, 'The launcher must expose its isolated harness runtime')
  const base = await ownedFilesystem(ctx, storageRoot)
  const runtime = await ownedFilesystem(ctx, managedRuntimeRoot)
  return ApprovedRootAllowlistSchema.parse({
    schemaVersion: 1, hostRef: { kind: 'main', mainId }, applicationInstallationId: mainId,
    configurationRevision: '1',
    bases: [{
      baseId: mainStorageBaseId(mainId, storageRoot), canonicalPath: storageRoot,
      filesystem: base.filesystem, filesystemId: base.filesystemId, accessModes: ['read-only', 'read-write'],
    }],
    managedRuntimeRoot, runtimeFilesystem: runtime.filesystem, runtimeFilesystemId: runtime.filesystemId,
  })
}
