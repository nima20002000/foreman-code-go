import type pg from 'pg'
import { CiGetOutputSchema, CiRunOutputSchema, type CiRunInput, type CiGetInput,
  type CiCancelInput, type CiLogsInput, type CiArtifactInput } from '@foreman-code/contracts'
import { AutoVerificationJobSpecSchema, JobVerificationReportReadSchema, type JobDefinitionRecord }
  from '@foreman-code/contracts/job-verification'
import type { ManagementAction, ManagementPrincipal } from '@foreman-code/contracts/management'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { PostgresSourceService } from '../sources/service.js'
import type { JobService } from './service.js'
import { CI_GET_ACTIONS, CI_RUN_ACTIONS, type CiAuthority } from './ciAuthority.js'
import { canonical, jobDigest } from './digest.js'
import { DomainError } from '../errors.js'
import { DeviceAccessError } from '../devices/access.js'
import { DeviceApplicationError } from '../devices/deviceApplicationError.js'
import { z } from 'zod'
import { MaterializationReceiptSchema } from '@foreman-code/contracts/source-materialization'
import type { ApprovedSourcePin, SourceRootRecord } from '@foreman-code/contracts/source-admission'
import { jobQueueHasExecution } from '@foreman-code/contracts/job-admission'

/** The few facts CI needs from an Agent's accepted native placement. */
const AgentPlacementFacts = z.object({
  materialization: z.object({ receipt: z.object({ binding: z.object({ mainId: z.uuid(), deviceId: z.uuid().nullable() }).loose(),
    worktree: MaterializationReceiptSchema.shape.worktree }).loose() }).loose(),
  workingTree: z.object({ canonicalProjectRoot: z.string().startsWith('/') }).loose(),
}).loose()

export type AgentHostRef = { kind: 'main'; mainId: string } | { kind: 'device'; mainId: string; deviceId: string }

export class CiService {
  constructor(private readonly pool: pg.Pool, private readonly commands: PostgresCommandCoordinator,
    private readonly authority: CiAuthority, private readonly sources: PostgresSourceService,
    private readonly jobs: JobService) {}
  /** Reads an Agent's current files from the computer it runs on (Main locally, laptops over their channel). */
  snapshots?: (hostRef: AgentHostRef, path: string, baseCommit: string) => Promise<{ commit: string; bundle: Buffer }>

  async run(caller: ManagementPrincipal, input: CiRunInput & { workspaceId?: string }) {
    const scope = await this.authority.resolve(caller, input.workspaceId, CI_RUN_ACTIONS)
    const commandKey = jobDigest({ callerId: caller.id, commandId: input.commandId })
    const outcome = await this.commands.execute({ principal: caller, source: 'mcp', operation: 'ci.run',
      commandId: input.commandId, targetKey: scope.workspaceId, payload: input, dedicatedConnection: true,
      authorize: async () => { await this.authority.resolve(caller, scope.workspaceId, CI_RUN_ACTIONS) },
      perform: async commandConnection => {
        // An Agent's CI tests its current files and runs on its own computer first, then spills over in build order.
        const agent = scope.executionId ? await this.agentWorkspace(scope.executionId) : undefined
        let preferredHost = agent?.hostRef
        if (input.placementOverride?.kind === 'explicit') preferredHost = input.placementOverride.target.hostRef
        if (input.placementOverride?.kind === 'prefer') preferredHost = input.placementOverride.hostRef
        const placementOverride = input.placementOverride ?? (agent ? { kind: 'prefer' as const, hostRef: agent.hostRef } : undefined)
        const captured = await this.commands.execute({ principal: caller, source: 'mcp', operation: 'ci.snapshot',
          commandId: input.commandId, targetKey: scope.workspaceId, payload: input, dedicatedConnection: true,
          authorize: async () => { await this.authority.resolve(caller, scope.workspaceId, CI_RUN_ACTIONS) },
          perform: async () => {
            if (!agent?.worktree || input.commit || !this.snapshots) return null
            const snapshot = await this.snapshots(agent.hostRef, agent.path, agent.worktree.commit)
            return { baseCommit: agent.worktree.commit, commit: snapshot.commit,
              bundleBase64: snapshot.bundle.toString('base64') }
          },
        })
        const snapshot = captured.value ? { baseCommit: captured.value.baseCommit, commit: captured.value.commit,
          bundle: Buffer.from(captured.value.bundleBase64, 'base64') } : undefined
        const source = await this.sources.approveProject(scope.principal, {
          workspaceId: scope.workspaceId, commandId: `${commandKey}:source`,
          ...(input.commit ? { commit: input.commit } : {}), ...(snapshot ? { snapshot } : {}),
        })
        // Suite waiters use the command connection, leaving the application pool available for nested work.
        const lockKey = `ci:${scope.workspaceId}:${input.suite}`
        try {
          await commandConnection.query('select pg_advisory_lock(hashtext($1))', [lockKey])
          const prepared = await this.commands.execute({ principal: caller, source: 'mcp', operation: 'ci.prepare',
            commandId: input.commandId, targetKey: scope.workspaceId, payload: input, dedicatedConnection: true,
            authorize: async () => { await this.authority.resolve(caller, scope.workspaceId, CI_RUN_ACTIONS) },
            perform: async () => this.prepare(scope.principal, scope.workspaceId, input.suite, commandKey, source, preferredHost),
          })
          const admitted = await this.jobs.enqueue(scope.principal, 'mcp', scope.workspaceId, {
            commandId: `${commandKey}:enqueue`, definitionId: prepared.value.id,
            expectedRevision: prepared.value.revision,
            ...(placementOverride ? { placementOverride } : {}),
          }, { runtimePreparation: scope.principal, initiatingAgent: scope.initiatingAgent })
          if (admitted.kind === 'retained-execution') {
            throw new DomainError('CI_QUEUE_CONFLICT', 'The CI command belongs to an earlier nonqueued execution.', 409)
          }
          return CiRunOutputSchema.parse({ ticketId: admitted.kind === 'accepted' ? admitted.ticketId : admitted.ticket.id,
            ...(admitted.kind === 'accepted' ? { executionId: admitted.executionId } : {}) })
        } finally {
          await commandConnection.query('select pg_advisory_unlock(hashtext($1))', [lockKey])
        }
      },
    })
    return CiRunOutputSchema.parse(outcome.value)
  }

  private async agentWorkspace(executionId: string) {
    const row = (await this.pool.query<{ record: unknown }>('select record from execution_native_placements where execution_id=$1',
      [executionId])).rows[0]
    if (!row) return undefined
    const placement = AgentPlacementFacts.parse(row.record)
    const binding = placement.materialization.receipt.binding
    const hostRef: AgentHostRef = binding.deviceId ? { kind: 'device', mainId: binding.mainId, deviceId: binding.deviceId }
      : { kind: 'main', mainId: binding.mainId }
    return { hostRef, path: placement.workingTree.canonicalProjectRoot, worktree: placement.materialization.receipt.worktree }
  }

  private async prepare(principal: ManagementPrincipal, workspaceId: string, suite: CiRunInput['suite'],
    commandKey: string, source: Awaited<ReturnType<PostgresSourceService['approveProject']>>,
    preferredHost?: AgentHostRef): Promise<JobDefinitionRecord> {
    const choices = await this.jobs.choices(principal, workspaceId, 'mcp')
    // One Auto definition reaches every computer qualified for the same envelope; pick the envelope most computers can run.
    const templates = (choices.verificationTemplates ?? []).filter(value => value.suite === suite && value.outputs)
    const envelope = (value: (typeof templates)[number]) => canonical({ policy: value.policy, resources: value.resources,
      parameters: value.parameters, argv: value.argv, outputs: value.outputs })
    const ready = (value: (typeof templates)[number]) => templates.filter(other => other.ready && envelope(other) === envelope(value)).length
    const preferred = (value: (typeof templates)[number]) => Number(Boolean(preferredHost && value.ready
      && canonical(value.hostRef) === canonical(preferredHost)))
    const template = [...templates].sort((left, right) =>
      preferred(right) - preferred(left) || ready(right) - ready(left))[0]
    if (!template?.outputs) throw new DomainError('CI_SUITE_UNCONFIGURED',
      `Configure a verification runtime profile for ${suite} in this workspace.`, 409)
    const pin = { approvedSourceId: source.manifest.approvedSourceId, snapshotId: source.manifest.snapshotId,
      manifestDigest: source.manifest.manifestDigest }
    const roots = await this.sources.rootList(principal, 'mcp', { workspaceId, limit: 100 })
    let bound = 0
    for (const root of roots.items) {
      if (root.binding.accessMode !== 'exclusive-write') continue
      if (canonical(root.source) === canonical(pin)) { bound++; continue }
      try {
        await this.bindBuildRoot(principal, workspaceId, root, pin, commandKey)
        bound++
      } catch (error) {
        if (error instanceof DomainError && error.code === 'SOURCE_ROOT_REVISION_CONFLICT') throw error
        // An offline, removed or refusing computer (for example a root out of the workspace's current scope) is not a
        // build candidate for this commit; the queue uses the others.
        if (!(error instanceof DeviceAccessError) && !(error instanceof DeviceApplicationError)
          && !(error instanceof DomainError && ![401, 403].includes(error.status))) throw error
      }
    }
    if (!bound) throw new DomainError('CI_NO_BUILD_COMPUTER', 'No build computer root could receive this commit.', 409)
    const spec = AutoVerificationJobSpecSchema.parse({ source: { ...pin, commit: source.manifest.git!.commit },
      target: { kind: 'auto' }, runtimeSelection: 'qualified-profile',
      limits: template.resources.limits, policy: template.policy,
      argv: template.argv, inputs: [], outputs: template.outputs,
      verification: { suite, resources: template.resources, parameters: template.parameters, credentialRefs: [] } })
    const name = `CI: ${suite}`
    const definitions = await this.jobs.listDefinitions(principal, workspaceId, 'mcp')
    const old = definitions.find(value => value.name === name && 'verification' in value.spec)
    if (old && canonical(old.spec) === canonical(spec)) return old
    return this.jobs.saveDefinition(principal, 'mcp', workspaceId, {
      commandId: `${commandKey}:definition`, name, spec, expectedRevision: old?.revision ?? null,
      ...(old ? { id: old.id } : {}),
    })
  }

  private async bindBuildRoot(principal: ManagementPrincipal, workspaceId: string,
    root: SourceRootRecord, source: ApprovedSourcePin, commandKey: string): Promise<void> {
    let current = root
    while (canonical(current.source) !== canonical(source)) {
      try {
        await this.sources.bindRoot(principal, 'mcp', { workspaceId, source,
          selection: current.selection, accessMode: 'exclusive-write',
          expectedBindingRevision: current.binding.bindingRevision,
          commandId: `${commandKey}:root:${root.binding.rootId}:${current.binding.bindingRevision}` })
        return
      } catch (error) {
        if (!(error instanceof DomainError) || error.code !== 'SOURCE_ROOT_REVISION_CONFLICT') throw error
        const roots = await this.sources.rootList(principal, 'mcp', { workspaceId, limit: 100 })
        const updated = roots.items.find(value => value.binding.rootId === root.binding.rootId)
        if (!updated || updated.binding.bindingRevision <= current.binding.bindingRevision
          || updated.binding.accessMode !== 'exclusive-write'
          || canonical(updated.selection) !== canonical(root.selection)) throw error
        current = updated
      }
    }
  }

  async computers(caller: ManagementPrincipal, input: { workspaceId?: string }) {
    const { principal, workspaceId } = await this.authority.resolve(caller, input.workspaceId,
      ['job_definitions:read', 'sources:read', 'source_roots:read'])
    return this.jobs.choices(principal, workspaceId, 'mcp')
  }

  async cancel(caller: ManagementPrincipal, input: CiCancelInput & { workspaceId?: string }) {
    const { principal, workspaceId } = await this.authority.resolve(caller, input.workspaceId, ['jobs:cancel'])
    return { ticket: await this.jobs.cancelQueued(principal, 'mcp', workspaceId, {
      ticketId: input.ticketId, expectedRevision: input.expectedRevision, commandId: input.commandId,
    }) }
  }

  private async acceptedExecution(caller: ManagementPrincipal, input: CiGetInput & { workspaceId?: string },
    actions: ManagementAction[]) {
    const scope = await this.authority.resolve(caller, input.workspaceId, ['jobs:read', ...actions])
    const ticket = await this.jobs.getQueueTicket(scope.principal, scope.workspaceId, input.ticketId, 'mcp')
    if (!jobQueueHasExecution(ticket)) {
      throw new DomainError('CI_NOT_ACCEPTED', 'This CI request has no accepted execution yet. Poll ci_get.', 409)
    }
    return { ...scope, executionId: ticket.executionId }
  }

  async logs(caller: ManagementPrincipal, input: CiLogsInput & { workspaceId?: string }) {
    const scope = await this.acceptedExecution(caller, input, ['job_logs:read'])
    return this.jobs.readLogs(scope.principal, scope.workspaceId, scope.executionId,
      input.afterSequence, input.limit, 'mcp')
  }

  async artifacts(caller: ManagementPrincipal, input: CiGetInput & { workspaceId?: string }) {
    const scope = await this.acceptedExecution(caller, input, ['job_artifacts:read'])
    return { artifacts: await this.jobs.listArtifacts(scope.principal, scope.workspaceId, scope.executionId, 'mcp') }
  }

  async artifact(caller: ManagementPrincipal, input: CiArtifactInput & { workspaceId?: string }) {
    const scope = await this.acceptedExecution(caller, input, ['job_artifacts:read'])
    return this.jobs.readArtifactPage(scope.principal, scope.workspaceId, scope.executionId, input)
  }

  async get(caller: ManagementPrincipal, input: CiGetInput & { workspaceId?: string }) {
    const { principal, workspaceId } = await this.authority.resolve(caller, input.workspaceId, CI_GET_ACTIONS)
    const queue = await this.jobs.getQueueTicket(principal, workspaceId, input.ticketId, 'mcp')
    if (!jobQueueHasExecution(queue)) return CiGetOutputSchema.parse({ queue, executionId: null,
      process: null, publication: null, resultIssue: null, summaryReport: null,
      logTail: { text: '', truncated: false } })
    const execution = await this.jobs.getExecution(principal, workspaceId, queue.executionId, 'mcp')
    const logTail = await this.jobs.readLogTail(principal, workspaceId, execution.id)
    let summaryReport = null
    if (execution.schemaVersion === 2) {
      const artifacts = await this.jobs.listArtifacts(principal, workspaceId, execution.id, 'mcp')
      const declaration = execution.acceptedSpec.outputs.find(output => output.kind === 'suite-summary')!
      const artifact = artifacts.find(value => value.path === declaration.path && value.state === 'available')
      if (artifact && artifact.byteSize <= 1024 * 1024) {
        const { bytes } = await this.jobs.readArtifact(principal, workspaceId, execution.id,
          artifact.fileId, artifact.revisionId, 'mcp')
        const spec = execution.acceptedSpec
        summaryReport = JobVerificationReportReadSchema.parse({ report: JSON.parse(bytes.toString('utf8')),
          expected: { commit: spec.source.commit, manifestDigest: spec.source.manifestDigest,
            definitionVersionId: spec.definitionVersionId, suite: spec.verification.suite, executionId: execution.id,
            attemptId: execution.attemptId, target: spec.target, profile: spec.profile,
            resources: spec.verification.resources, parameters: spec.verification.parameters } })
      }
    }
    await this.authority.resolve(caller, workspaceId, CI_GET_ACTIONS)
    return CiGetOutputSchema.parse({ queue, executionId: execution.id, process: execution.process,
      publication: execution.publication, resultIssue: execution.resultIssue, summaryReport, logTail })
  }
}
