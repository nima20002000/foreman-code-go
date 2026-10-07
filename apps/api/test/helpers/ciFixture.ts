import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { JobQueueTicketSchema } from '@foreman-code/contracts/job-admission'
import { JobDefinitionRecordSchema, jobPolicyRequirementsRecord, jobVerificationTemplate,
  JobVerificationReportSchema, VerificationJobExecutionSchema } from '@foreman-code/contracts/job-verification'
import { ManagementActionSchema, type ManagementPrincipal } from '@foreman-code/contracts/management'
import type { PostgresCommandCoordinator } from '../../src/modules/commands/postgres.js'
import type { PostgresSourceService } from '../../src/modules/sources/service.js'
import type { JobService } from '../../src/modules/jobs/service.js'
import { CiService } from '../../src/modules/jobs/ci.js'
import type { CiAuthority } from '../../src/modules/jobs/ciAuthority.js'
import { requireAuthorization } from '../../src/modules/access/policy.js'
import { DomainError } from '../../src/modules/errors.js'
import { DeviceAccessError } from '../../src/modules/devices/access.js'
import { jobDigest } from '../../src/modules/jobs/digest.js'
import { createSourceManifest } from '../../src/modules/sources/manifest.js'
import { jobExecution } from './jobFixture.js'
import { verificationRuntimeFixture } from './verificationRuntimeFixture.js'
import type { OperatorServices } from '../../src/mcp/operator/types.js'

/** Retained domain data for transport tests. No PostgreSQL or physical host is used. */
export function ciFixture() {
  const workspaceId = 'workspace-fixture'
  const operator: ManagementPrincipal = { id: 'ci-operator', name: 'CI operator', audience: 'operator',
    expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null,
    grants: [{ actions: [...ManagementActionSchema.options], scope: { workspaceIds: [workspaceId] } }] }
  const worker: ManagementPrincipal = { ...operator, id: 'ci-agent', audience: 'worker', agentId: 'agent',
    grants: [{ actions: ['interactions:read'], scope: {
      workspaceIds: [workspaceId], workflowIds: ['workflow'], runIds: ['run'],
    } }] }
  const accepted = { ...operator, id: 'accepted-run-principal' }
  const readonly = { ...operator, id: 'readonly-operator', grants: [{ actions: ['jobs:read' as const],
    scope: { workspaceIds: [workspaceId] } }] }
  const receipts = new Map<string, { digest: string; target: string; result: unknown }>()
  const audits: Array<{ principalId: string; action: string; outcome: string }> = []
  const commands = {
    execute: async (input: { principal: ManagementPrincipal; operation: string; commandId: string;
      targetKey: string; payload: unknown; authorize?(sql: unknown): Promise<void>; perform(sql: unknown): Promise<unknown> }) => {
      await input.authorize?.({})
      const key = `${input.principal.id}:${input.operation}:${input.commandId}`
      const digest = jobDigest(input.payload)
      const existing = receipts.get(key)
      if (existing) {
        if (digest !== existing.digest || input.targetKey !== existing.target) {
          throw new DomainError('COMMAND_ID_CONFLICT', 'Command input changed.', 409)
        }
        return { value: structuredClone(existing.result), replayed: true }
      }
      const value = await input.perform({})
      receipts.set(key, { digest, target: input.targetKey, result: structuredClone(value) })
      audits.push({ principalId: input.principal.id, action: input.operation, outcome: 'succeeded' })
      return { value, replayed: false }
    },
    recordDenied: async (principalId: string, _source: string, action: string) => {
      audits.push({ principalId, action, outcome: 'denied' })
    },
    recordAudit: async (principalId: string, _source: string, action: string, _target: string, outcome: string) => {
      audits.push({ principalId, action, outcome })
    },
  } as unknown as PostgresCommandCoordinator
  let head = 'b'.repeat(40)
  let sourceCaptures = 0
  let enqueues = 0
  let definition: ReturnType<typeof JobDefinitionRecordSchema.parse> | undefined
  let ticket: ReturnType<typeof JobQueueTicketSchema.parse> | undefined
  let execution: ReturnType<typeof VerificationJobExecutionSchema.parse> | undefined
  let summary: ReturnType<typeof JobVerificationReportSchema.parse> | undefined
  const runtime = verificationRuntimeFixture()
  const roots: { offline: boolean; source: unknown; selection: { rootPolicyId: string }
    binding: { rootId: string; bindingRevision: number; accessMode: 'exclusive-write' } }[] = [
    { offline: false, source: null, selection: { rootPolicyId: 'online-root' },
      binding: { rootId: randomUUID(), bindingRevision: 1, accessMode: 'exclusive-write' } },
    { offline: true, source: null, selection: { rootPolicyId: 'offline-root' },
      binding: { rootId: randomUUID(), bindingRevision: 1, accessMode: 'exclusive-write' } },
  ]
  const approvals: unknown[] = [], enqueued: unknown[] = []
  const agentExecution: { id?: string } = {}
  const authority: CiAuthority = { resolve: async (caller, requested, actions) => {
    if (caller.audience === 'worker' && caller.id !== worker.id) {
      throw new DomainError('ACCESS_DENIED', 'Unknown Run workspace.', 403)
    }
    const resolved = caller.audience === 'worker' ? workspaceId : requested
    if (!resolved || caller.audience === 'worker' && requested && requested !== workspaceId) {
      throw new DomainError('ACCESS_DENIED', 'Foreign workspace.', 403)
    }
    const principal = caller.audience === 'worker' ? accepted : caller
    for (const action of actions) requireAuthorization(principal, action, { workspaceId: resolved })
    return { principal, workspaceId: resolved, ...(caller.audience === 'worker' && agentExecution.id ? { executionId: agentExecution.id } : {}) }
  } }
  const sources = {
    approveProject: async (principal: ManagementPrincipal, input: { workspaceId: string; commandId: string; commit?: string
      snapshot?: { commit: string } }) => (approvals.push(input), await commands.execute({ principal, source: 'mcp', operation: 'source.project.capture',
        commandId: input.commandId, targetKey: workspaceId, payload: input, perform: async () => {
          sourceCaptures++
          const manifest = createSourceManifest({ version: 1, approvedSourceId: randomUUID(), snapshotId: randomUUID(),
            capturePolicy: 'git-tree-v1', executablePolicy: 'preserve-approved', deletions: [],
            git: { commit: input.snapshot?.commit ?? input.commit ?? head, tree: 'c'.repeat(40), objectFormat: 'sha1' },
            entries: ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].sort().map(path => ({
              path, sha256: 'a'.repeat(64), kind: 'file', executable: false, byteSize: 1,
            })) })
          return { manifest, workspaceId }
        } })).value,
    rootList: async () => ({ items: roots.map(root => structuredClone(root)) }),
    bindRoot: async (_principal: ManagementPrincipal, _source: string, input: { source: unknown; selection: { rootPolicyId: string } }) => {
      const root = roots.find(value => value.selection.rootPolicyId === input.selection.rootPolicyId)!
      if (root.offline) throw new DeviceAccessError('revoked')
      root.source = input.source
      root.binding.bindingRevision++
      return structuredClone(root)
    },
  } as unknown as PostgresSourceService
  const scopeCheck = (principal: ManagementPrincipal, scope: string) =>
    requireAuthorization(principal, 'jobs:read', { workspaceId: scope })
  const jobs = {
    choices: async () => ({ verificationTemplates: [jobVerificationTemplate({ profileId: 'profile', profileRevision: 1,
      suite: 'unit', ready: true, resources: runtime.spec.verification.resources, maxUnitWorkers: 1,
      policy: jobPolicyRequirementsRecord(runtime.spec.policy) })] }),
    listDefinitions: async () => definition ? [structuredClone(definition)] : [],
    saveDefinition: async (_principal: ManagementPrincipal, _source: string, scope: string,
      input: { name: string; spec: unknown }) => {
      const now = new Date().toISOString()
      definition = JobDefinitionRecordSchema.parse({ schemaVersion: 2, id: definition?.id ?? randomUUID(),
        workspaceId: scope, revision: (definition?.revision ?? 0) + 1, versionId: randomUUID(),
        name: input.name, spec: input.spec, createdAt: now, updatedAt: now })
      return structuredClone(definition)
    },
    enqueue: async (principal: ManagementPrincipal, _source: string, scope: string, input: { commandId: string }) => {
      enqueues++
      enqueued.push(input)
      expectDefinition()
      // One instant: the deadline is exactly the queue timeout after enqueue, even on a loaded machine.
      const at = Date.now(), now = new Date(at).toISOString()
      ticket = JobQueueTicketSchema.parse({ schemaVersion: 1, id: randomUUID(), workspaceId: scope, revision: 1,
        commandId: input.commandId, commandDigest: jobDigest(input), principalId: principal.id, definition,
        executionId: randomUUID(), attemptId: randomUUID(), operationId: randomUUID(), workflow: null, gateId: null,
        placement: { kind: 'auto' }, placementOverride: null, resources: runtime.spec.verification.resources,
        enqueueSequence: '1', enqueuedAt: now, deadlineAt: new Date(at + 60_000).toISOString(),
        state: 'waiting', waitingReasons: ['busy'], compatibleTargetCount: 1, queuePosition: 1, estimatedStartAt: null,
        reservationId: null, cancelRequestedAt: null, terminalReason: null, finishedAt: null })
      return { kind: 'pending-admission', ticket: structuredClone(ticket) }
    },
    getQueueTicket: async (principal: ManagementPrincipal, scope: string, id: string) => {
      scopeCheck(principal, scope)
      if (!ticket || scope !== ticket.workspaceId || id !== ticket.id) {
        throw new DomainError('JOB_QUEUE_NOT_FOUND', 'Ticket not found in this workspace.', 404)
      }
      return structuredClone(ticket)
    },
    getExecution: async () => structuredClone(execution),
    readLogTail: async () => ({ text: 'tests passed\n', truncated: false }),
    listArtifacts: async () => [{ path: execution!.acceptedSpec.outputs[0]!.path, state: 'available',
      byteSize: Buffer.byteLength(JSON.stringify(summary)), fileId: 'summary-file', revisionId: 'summary-revision' }],
    readArtifact: async () => ({ bytes: Buffer.from(JSON.stringify(summary)) }),
  } as unknown as JobService
  function expectDefinition() { if (!definition) throw new Error('Missing saved definition') }
  const agent = { mainId: '11111111-1111-4111-8111-111111111111', deviceId: '22222222-2222-4222-8222-222222222222' }
  const pool = { connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
    query: async (text: string) => text.includes('execution_native_placements') ? { rows: [{ record: {
      materialization: { receipt: { binding: { mainId: agent.mainId, deviceId: agent.deviceId },
        worktree: { repository: 'octo/site', branch: 'foreman/review/coder-1', commit: 'b'.repeat(40) } } },
      workingTree: { canonicalProjectRoot: '/home/laptop/root/x/tree' } } }] } : { rows: [] } } as unknown as pg.Pool
  const snapshotCalls: { hostRef: unknown; path: string; baseCommit: string }[] = []
  const createCi = () => Object.assign(new CiService(pool, commands, authority, sources, jobs), {
    snapshots: async (hostRef: unknown, path: string, baseCommit: string) => {
      snapshotCalls.push({ hostRef, path, baseCommit })
      return { commit: 'c'.repeat(40), bundle: Buffer.from('bundle') }
    } })
  const services = { commands, ci: createCi() } as unknown as OperatorServices
  return { workspaceId, worker, operator, readonly, services, audits, createCi, roots, snapshotCalls, approvals, enqueued, agent, agentExecution,
    counts: () => ({ sourceCaptures, enqueues }), advanceHead: () => { head = 'd'.repeat(40) },
    complete: () => {
      if (!ticket) throw new Error('Missing queued ticket')
      execution = VerificationJobExecutionSchema.parse({ ...jobExecution(), schemaVersion: 2,
        id: ticket.executionId, attemptId: ticket.attemptId, operationId: ticket.operationId, workspaceId,
        acceptedSpec: { ...runtime.spec, definitionVersionId: ticket.definition.versionId,
          source: { ...runtime.spec.source, ...ticket.definition.spec.source } }, publication: 'complete',
        process: { phase: 'terminal', outcome: 'succeeded', exitCode: 0, signal: null, processStopped: true } })
      ticket = JobQueueTicketSchema.parse({ ...ticket, state: 'accepted', reservationId: ticket.id,
        waitingReasons: [], selectedComputer: { target: runtime.spec.target,
          rootId: runtime.spec.profile.rootId, bindingRevision: 1, profileId: 'profile', profileRevision: 1 } })
      const spec = execution!.acceptedSpec
      summary = JobVerificationReportSchema.parse({ schemaVersion: 1, commit: spec.source.commit,
        manifestDigest: spec.source.manifestDigest, definitionVersionId: spec.definitionVersionId,
        suite: 'unit', executionId: execution!.id, attemptId: execution!.attemptId, target: spec.target,
        profile: spec.profile, resources: spec.verification.resources, parameters: spec.verification.parameters,
        startedAt: ticket.enqueuedAt, finishedAt: new Date().toISOString(),
        totals: { total: 3, passed: 3, failed: 0, skipped: 0 }, firstPassFailed: 0, expectedPortions: 1,
        completedPortions: 1, disallowedSkipped: 0, completeness: 'complete', outcome: 'passed' })
    },
  }
}
