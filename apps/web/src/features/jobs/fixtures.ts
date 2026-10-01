import type { JobDefinition, JobExecution, JobLogPage } from '@graphql/contracts/jobs'
const digest = 'a'.repeat(64)
const uuid = '11111111-1111-4111-8111-111111111111'
export const definition: JobDefinition = {
  schemaVersion: 1, id: 'job-a', workspaceId: 'workspace-a', name: 'Web build', revision: 1, versionId: 'version-a', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
  spec: { argv: ['corepack', 'pnpm', 'build'], inputs: [], outputs: [{ path: 'apps/web/dist/index.html', required: true, mediaType: 'text/html' }],
    source: { approvedSourceId: uuid, snapshotId: uuid, commit: 'b'.repeat(40), manifestDigest: digest },
    target: { schemaVersion: 1, mainId: uuid, mainInstallationId: 'main-installation', hostRef: { kind: 'main', mainId: uuid }, registration: null, labelAtAcceptance: 'Qualified PC',
      destination: { canonicalProjectRoot: '/synthetic/root', canonicalCwd: '/synthetic/root', managedRuntimeRoot: '/synthetic/runtime', directoryIdentityHash: digest, rootPolicyId: 'root-a', rootPolicyRevision: '1', locationRevision: '1', attestationId: 'attestation-a', attestationHash: digest } },
    policy: { isolationPolicyId: 'rootless-oci', isolationPolicyRevision: 1, imageDigest: `sha256:${digest}`, toolchainDigest: digest, environmentScopeRefs: [], network: 'none', queueTimeoutMs: 10000, preparationTimeoutMs: 10000, executionTimeoutMs: 60000, cancellationGraceMs: 1000, maxLogChunkBytes: 65536, maxLogBytes: 1048576, maxWorkerSpoolBytes: 1048576, logOverflow: 'explicit-truncation', maxOutputBytes: 1048576, retentionSeconds: 3600 },
  },
}
export const execution: JobExecution = {
  schemaVersion: 1, id: 'execution-a', workspaceId: 'workspace-a', acceptedSpec: { ...definition.spec, workflowInput:null,source:{...definition.spec.source,materializationId:uuid,materializationDigest:digest}, definitionId: definition.id, definitionRevision: 1, definitionVersionId: definition.versionId, scriptDigest: digest, outputSpecDigest: digest, specDigest: digest, bindingHash: digest },
  operationId: 'operation-a', attemptId: 'attempt-a', owner: { grantId: 'grant-a', epoch: '1' }, workflow: null,
  process: { phase: 'terminal', outcome: 'build_failed', exitCode: 7, signal: null, processStopped: true }, transport: 'connected', publication: 'complete', cancelRequestedAt: null,
  createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:03Z', startedAt: '2026-10-01T00:00:01Z', finishedAt: '2026-10-01T00:00:03Z', lastSeenAt: '2026-10-01T00:00:03Z', resultIssue: 'missing_output',
}
export const logPage: JobLogPage = { chunks: [{ executionId: execution.id, attemptId: execution.attemptId, sequence: 1, stream: 'stderr', text: 'build failed <script>bad()</script>\nλ🙂', byteSize: 45, createdAt: execution.updatedAt }], nextCursor: 1, truncated: false, gap: null }
