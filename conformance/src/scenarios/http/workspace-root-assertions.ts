import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  WorkspaceRootAttestationSchema,
  WorkspaceRootPolicySchema,
  WorkspaceRootSelectionSchema,
  type ApprovedRootAllowlist,
  type WorkspaceRootAttestation,
  type WorkspaceRootSelection,
} from '@foreman-code/contracts/workspace-root-policies'
import {
  WorkspaceBoundLocationReadbackSchema,
  WorkspaceBoundLocationSetInputSchema,
  WorkspaceBoundLocationSetResultSchema,
  WorkspaceBoundLocationValidationSchema,
} from '@foreman-code/contracts/workspace-bound-location'
import { assertResponse } from '../../assertions.js'
import type { ScenarioContext } from '../../scenario.js'
import { bytesSha256 } from '../codecs/fixtures.js'

export interface WorkspaceRootFixture {
  configuration: ApprovedRootAllowlist
  selection: WorkspaceRootSelection
  filesystem: WorkspaceRootAttestation['filesystem']
}

/** The frozen root digests hash the exact ordered JSON bytes of their shared contract facts. */
export function rootAttestationExpectation(fixture: WorkspaceRootFixture, attestationId: string) {
  const { configuration, selection, filesystem } = fixture
  const base = configuration.bases.find(item => item.baseId === selection.allowedBaseId)
  assert.ok(base, 'The expected selection must belong to the configured fixture base')
  const stamp = {
    schemaVersion: 1 as const, attestationId,
    requestDigest: bytesSha256(Buffer.from(JSON.stringify(WorkspaceRootSelectionSchema.parse(selection)))),
    hostRef: configuration.hostRef, applicationInstallationId: configuration.applicationInstallationId,
    configurationRevision: configuration.configurationRevision, allowedBaseId: base.baseId,
    relativePath: selection.relativePath, accessMode: selection.accessMode,
    canonicalProjectRoot: join(base.canonicalPath, selection.relativePath), filesystem,
    directoryIdentityHash: bytesSha256(Buffer.from(JSON.stringify(filesystem))),
    managedRuntimeRoot: configuration.managedRuntimeRoot, runtimeFilesystem: configuration.runtimeFilesystem,
  }
  return WorkspaceRootAttestationSchema.parse({
    ...stamp, attestationDigest: bytesSha256(Buffer.from(JSON.stringify(stamp))),
  })
}

export async function assertRootValidation(ctx: ScenarioContext, path: string, fixture: WorkspaceRootFixture) {
  const response = await ctx.http.request('POST', path, { body: fixture.selection })
  const actual = WorkspaceBoundLocationValidationSchema.parse(response.body)
  const attestation = rootAttestationExpectation(fixture, actual.attestation.attestationId)
  assertResponse(response, { status: 200, body: {
    workspaceId: fixture.selection.workspaceId, selection: fixture.selection,
    attestation: { ...attestation, attestationId: '<uuid>' }, checkedAt: '<timestamp>',
  } }, [
    { pointer: '/body/attestation/attestationId', kind: 'uuid' },
    { pointer: '/body/checkedAt', kind: 'timestamp' },
  ])
  return attestation
}

export async function bindMainRoot(ctx: ScenarioContext, path: string, fixture: WorkspaceRootFixture) {
  assert.equal(fixture.selection.hostRef.kind, 'main')
  const input = WorkspaceBoundLocationSetInputSchema.parse({ ...fixture.selection, commandId: randomUUID() })
  const response = await ctx.http.request('PUT', path, { body: input })
  const actual = WorkspaceBoundLocationSetResultSchema.parse(response.body).value
  assert.ok(actual.evidence === 'bound', 'The accepted Main root must have persisted binding evidence')
  const attestation = rootAttestationExpectation(fixture, actual.binding.attestationId)
  const { selection, configuration } = fixture
  const locationRevision = selection.expectedLocationRevision + 1
  const binding = WorkspaceRootPolicySchema.parse({
    schemaVersion: 1, rootPolicyId: actual.binding.rootPolicyId,
    rootPolicyRevision: String(selection.expectedRootPolicyRevision + 1), workspaceId: selection.workspaceId,
    hostRef: selection.hostRef, applicationInstallationId: configuration.applicationInstallationId,
    registration: null, locationRevision: String(locationRevision), ownerPrincipalId: 'principal-local-human',
    allowedBaseId: selection.allowedBaseId, configurationRevision: configuration.configurationRevision,
    relativePath: selection.relativePath, accessMode: selection.accessMode,
    canonicalProjectRoot: attestation.canonicalProjectRoot, filesystem: fixture.filesystem,
    directoryIdentityHash: attestation.directoryIdentityHash, managedRuntimeRoot: configuration.managedRuntimeRoot,
    runtimeFilesystem: configuration.runtimeFilesystem,
    attestationId: attestation.attestationId, attestationDigest: attestation.attestationDigest,
  })
  const bound = WorkspaceBoundLocationReadbackSchema.parse({
    evidence: 'bound', workspaceId: selection.workspaceId, locationRevision,
    executionLocation: { runnerId: 'runner-local', rootPath: attestation.canonicalProjectRoot }, binding,
  })
  assert.ok(bound.evidence === 'bound')
  assertResponse(response, { status: 200, body: { value: {
    ...bound, binding: { ...binding, rootPolicyId: '<uuid>', attestationId: '<uuid>' },
  }, replayed: false } }, [
    { pointer: '/body/value/binding/rootPolicyId', kind: 'uuid' },
    { pointer: '/body/value/binding/attestationId', kind: 'uuid' },
  ])
  assertResponse(await ctx.http.request('PUT', path, { body: input }), {
    status: 200, body: { value: bound, replayed: true },
  })
  return { input, bound }
}
