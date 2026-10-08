import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { HarnessExecutionSchema } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture, WorkflowRunV3Schema } from '@foreman-code/contracts/wave25'
import { jobVerificationTemplate } from '@foreman-code/contracts/job-verification'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { CiService } from '../src/modules/jobs/ci.js'
import { CI_RUN_ACTIONS, RunCiAuthority } from '../src/modules/jobs/ciAuthority.js'
import { ciFixture } from './helpers/ciFixture.js'
import { ciPreparationFixture, commit } from './helpers/ciPreparationFixture.js'

function authorityPool(base: pg.Pool, operator: ManagementPrincipal, workspaceId: string) {
  const workflow = makeCurrentWorkflowFixture('ci-authority')
  workflow.version.workspaceId = workspaceId
  workflow.version.definition.workspaceId = workspaceId
  workflow.configurations.forEach(configuration => { configuration.workspaceId = workspaceId })
  const run = WorkflowRunV3Schema.parse({ ...workflow.run, workspaceId, executionState: 'running',
    authorizationPrincipalId: 'accepted-ci-authority' })
  const identity = workflow.identities[0]!
  const execution = HarnessExecutionSchema.parse({ id: identity.executionId, runId: run.id,
    workflowNodeId: identity.workflowNodeId, agentId: identity.agentId,
    agentConfigurationVersionId: identity.agentConfigurationVersionId, attempt: 1, input: {},
    state: 'starting', createdAt: workflow.createdAt, startedAt: workflow.createdAt })
  const worker: ManagementPrincipal = { ...operator, id: 'ci-agent', audience: 'worker', agentId: execution.agentId,
    grants: [{ actions: ['interactions:read'], scope: { workspaceIds: [workspaceId],
      workflowIds: [run.workflowId], runIds: [run.id] } }] }
  const accepted = { ...operator, id: 'accepted-ci-authority' }
  const query = async (text: string, values?: unknown[]) => {
    if (text.includes('from worker_credential_bindings b')) return { rows: [{
      execution_id: execution.id, run_id: run.id, workspace_id: workspaceId, workflow_id: run.workflowId,
      agent_id: execution.agentId, purpose: 'workflow', live: true, environment_variable: 'GRAPHQL_MCP_TOKEN',
      execution_semantics_version: 3, approval_native_session_id: null, approval_connection_generation: null,
      authorization_principal_id: accepted.id,
    }] }
    if (text.includes('from harness_executions e')) return { rows: [{ run, version: workflow.version, execution,
      configuration: workflow.configurations[0], attempt: 1, stopped: false, execution_closed: false,
      native_reference: null, finalized: false, generation: null, native_owner: null, budget_active: false }] }
    if (text.includes('from run_authority_principals b')) return { rows: [{ owner_principal_id: operator.id,
      grant_ceiling: accepted.grants, accepted_expires_at: new Date(accepted.expiresAt),
      execution_state: 'running', cleanup_pending: false }] }
    if (text.includes('from management_principals') && values?.[0] === accepted.id) return { rows: [{
      id: accepted.id, name: accepted.name, audience: 'operator', grants: accepted.grants,
      expires_at: new Date(accepted.expiresAt), revoked_at: null, delegated_from: operator.id }] }
    return base.query(text, values)
  }
  return { worker, accepted, pool: { query, connect: async () => ({ query, release: () => {} }) } as unknown as pg.Pool }
}

describe('automatic preparation uses the original CI authority', () => {
  it.each(['operator', 'worker'] as const)('starts preparation for %s CI through the real authority resolver', async audience => {
    const preparation = await ciPreparationFixture()
    const ci = ciFixture({ initialWaitingReasons: [] })
    const facts = authorityPool(preparation.pool, ci.operator, ci.workspaceId)
    preparation.principals.set(facts.accepted.id, facts.accepted)
    const profile = preparation.profiles.get('p-unit')!
    ci.templates.splice(0, ci.templates.length, jobVerificationTemplate({ profileId: profile.id, profileRevision: profile.revision,
      suite: 'unit', ready: true, policy: profile.spec.policy, resources: profile.spec.resources, maxUnitWorkers: 1 }))
    const service = new CiService(facts.pool, ci.commands, new RunCiAuthority(facts.pool), ci.sources, ci.jobs)
    try {
      const result = await service.run(audience === 'operator' ? ci.operator : facts.worker,
        { workspaceId: ci.workspaceId, suite: 'unit', commit, commandId: 'changed-dependencies' })
      const original = ci.ticket()
      expect(original.id).toBe(result.ticketId)
      expect(original.waitingReasons).toEqual([])
      expect(preparation.calls.prepare).toEqual([])
      await preparation.ciRuntime.prepareForTicket({ ...original, state: 'blocked', waitingReasons: ['dependencies_changed'] })
      expect(await preparation.settle('p-unit')).toMatchObject({ state: 'qualified', commit })
      expect(preparation.calls.prepare).toHaveLength(1)
      expect(original.runtimePreparation?.grants.some(grant => grant.actions.includes('job_artifacts:read'))).toBe(true)
    } finally { await preparation.ciRuntime.close(); await preparation.app.close() }
  })

  it('does not invent artifact access when the caller’s actual token lacks it', async () => {
    const f = await ciPreparationFixture()
    try {
      const token = { ...f.operator, grants: f.operator.grants.map(grant => ({ ...grant,
        actions: grant.actions.filter(action => action !== 'job_artifacts:read') })) }
      const resolved = await new RunCiAuthority(f.pool).resolve(token, f.workspaceId, CI_RUN_ACTIONS)
      expect(resolved.principal.grants.every(grant => !grant.actions.includes('job_artifacts:read'))).toBe(true)
      await expect(f.ciRuntime.start(resolved.principal, 'mcp', { workspaceId: f.workspaceId,
        profileId: 'p-unit', commit, commandId: 'missing-artifacts' })).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
      expect(f.calls.prepare).toEqual([])
    } finally { await f.ciRuntime.close(); await f.app.close() }
  })
})
