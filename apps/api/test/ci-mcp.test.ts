import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { CiGetOutputSchema, CiRunOutputSchema } from '@foreman-code/contracts'
import type { PostgresAccessService } from '../src/modules/access/postgres.js'
import type { AppInteractionService } from '../src/modules/interactions/app.js'
import { DomainError } from '../src/modules/errors.js'
import { registerGraphqlMcp } from '../src/mcp/unified/transport.js'
import { ciFixture } from './helpers/ciFixture.js'

async function fixture() {
  const data = ciFixture()
  const app = Fastify()
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof DomainError ? error.status : 500)
    .send({ error: 'Request denied.' }))
  const access = { authenticate: async (token: string) => {
    const principal = { worker: data.worker, operator: data.operator, readonly: data.readonly,
      foreign: { ...data.worker, id: 'foreign-agent' }, disabled: { ...data.worker, id: 'disabled-agent' } }[token]
    if (!principal) throw new DomainError('AUTH_INVALID', 'Invalid bearer token.', 401)
    return principal
  } } as unknown as PostgresAccessService
  const interactions = { toolAccess: async (principal: { id: string }) => ({ role: 'coder',
    tools: principal.id === 'disabled-agent' ? ['context_get'] : ['ci_run', 'ci_get'] }),
  canRead: async () => false, canRespond: async () => false } as unknown as AppInteractionService
  registerGraphqlMcp(app, { access, operator: data.services, interactions })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const request = async (method: string, params: unknown, token = 'worker') => {
    const response = await fetch(new URL('/mcp', address), { method: 'POST',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream',
        'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
    const text = await response.text()
    const body = text.split('\n').find(line => line.startsWith('data: '))?.slice(6) ?? text
    return { status: response.status, ...JSON.parse(body) }
  }
  const call = (name: string, input: unknown, token = 'worker') =>
    request('tools/call', { name, arguments: input }, token)
  return { ...data, app, call, request }
}

describe('CI over the authenticated unified MCP transport', () => {
  it('lists Agent schemas with no workspace selector and Operator schemas with workspaceId', async () => {
    const f = await fixture()
    try {
      const workerTools = (await f.request('tools/list', {})).result.tools
      expect(workerTools.map((tool: { name: string }) => tool.name)).toEqual(['ci_run', 'ci_get'])
      expect(workerTools[0].inputSchema.properties).not.toHaveProperty('workspaceId')
      const operatorTools = (await f.request('tools/list', {}, 'operator')).result.tools
      expect(operatorTools.find((tool: { name: string }) => tool.name === 'ci_run').inputSchema.required)
        .toContain('workspaceId')
    } finally { await f.app.close() }
  })

  it('retries one command after HEAD advances and reads retained queue and published results after service recreation', async () => {
    const f = await fixture()
    try {
      const input = { suite: 'unit', commandId: 'ci-command' }
      const first = await f.call('ci_run', input)
      expect(first.result.isError).not.toBe(true)
      const started = CiRunOutputSchema.parse(first.result.structuredContent)
      f.advanceHead()
      f.services.ci = f.createCi()
      const retry = await f.call('ci_run', input)
      expect(CiRunOutputSchema.parse(retry.result.structuredContent)).toEqual(started)
      expect(f.counts()).toEqual({ sourceCaptures: 1, enqueues: 1 })
      const waiting = await f.call('ci_get', { ticketId: started.ticketId })
      expect(CiGetOutputSchema.parse(waiting.result.structuredContent)).toMatchObject({
        queue: { state: 'waiting', waitingReasons: ['busy'], principalId: 'accepted-run-principal',
          definition: { spec: { source: { commit: 'b'.repeat(40) }, target: { kind: 'auto' } } } }, process: null,
      })
      f.complete()
      const read = CiGetOutputSchema.parse((await f.call('ci_get', { ticketId: started.ticketId })).result.structuredContent)
      expect(read).toMatchObject({ queue: { state: 'accepted', selectedComputer: { profileId: 'profile' } },
        process: { outcome: 'succeeded', exitCode: 0 }, publication: 'complete',
        summaryReport: { report: { outcome: 'passed', commit: 'b'.repeat(40), totals: { total: 3 } } },
        logTail: { text: 'tests passed\n', truncated: false } })
      expect(f.audits).toContainEqual({ principalId: f.worker.id, action: 'ci.run', outcome: 'succeeded' })
      expect(f.roots.map(root => root.binding.bindingRevision)).toEqual([2, 1])
      const changed = await f.call('ci_run', { ...input, commit: 'c'.repeat(40) })
      expect(JSON.stringify(changed.result)).toContain('COMMAND_ID_CONFLICT')
    } finally { await f.app.close() }
  })

  it.each(['collecting', 'failed', 'expired'] as const)(
    'returns an available failure summary while publication is %s for Agent and Operator callers',
    async publication => {
      const f = await fixture()
      try {
        const start = await f.call('ci_run', { suite: 'unit', commandId: 'partial-results' })
        const { ticketId } = CiRunOutputSchema.parse(start.result.structuredContent)
        f.complete({ publication, failed: true })
        f.services.ci = f.createCi()
        for (const token of ['worker', 'operator']) {
          const input = token === 'operator' ? { workspaceId: f.workspaceId, ticketId } : { ticketId }
          const read = await f.call('ci_get', input, token)
          expect(read.result.isError).not.toBe(true)
          expect(CiGetOutputSchema.parse(read.result.structuredContent)).toMatchObject({
            publication,
            resultIssue: publication === 'failed' ? 'publication_failed' : null,
            process: { outcome: 'build_failed', exitCode: 1 },
            summaryReport: { report: { outcome: 'failed', totals: { total: 3, passed: 2, failed: 1 } } },
          })
        }
        const denied = await f.call('ci_get', { ticketId }, 'foreign')
        expect(JSON.stringify(denied.result)).toContain('ACCESS_DENIED')
      } finally { await f.app.close() }
    },
  )

  it('denies foreign workspace tickets, disabled Agent tools, readonly Operators and invalid credentials', async () => {
    const f = await fixture()
    try {
      const started = CiRunOutputSchema.parse((await f.call('ci_run', {
        suite: 'unit', commandId: 'ci-command', commit: 'c'.repeat(40),
      })).result.structuredContent)
      const foreign = await f.call('ci_get', { ticketId: started.ticketId }, 'foreign')
      expect(JSON.stringify(foreign.result)).toContain('ACCESS_DENIED')
      const disabled = await f.call('ci_run', { suite: 'unit', commandId: 'other-command' }, 'disabled')
      expect(JSON.stringify(disabled.result)).toContain('TOOL_NOT_ENABLED')
      expect(f.audits).toContainEqual({ principalId: 'disabled-agent', action: 'ci_run', outcome: 'denied' })
      const readonly = await f.call('ci_run', { workspaceId: f.workspaceId, suite: 'unit', commandId: 'reader-command' }, 'readonly')
      expect(JSON.stringify(readonly.result)).toContain('ACCESS_DENIED')
      const wrongWorkspace = await f.call('ci_get', { workspaceId: 'foreign-workspace', ticketId: started.ticketId }, 'operator')
      expect(JSON.stringify(wrongWorkspace.result)).toContain('ACCESS_DENIED')
      expect((await f.call('ci_run', {}, 'invalid')).status).toBe(401)
      expect(f.counts()).toEqual({ sourceCaptures: 1, enqueues: 1 })
    } finally { await f.app.close() }
  })

  it('refuses CI when no build computer can receive the commit', async () => {
    const f = await fixture()
    try {
      f.roots[0]!.offline = true
      const result = await f.call('ci_run', { suite: 'unit', commandId: 'all-offline' })
      expect(JSON.stringify(result.result)).toContain('CI_NO_BUILD_COMPUTER')
      expect(f.counts().enqueues).toBe(0)
    } finally { await f.app.close() }
  })

  it('tests an Agent\'s current files and tries its own computer first', async () => {
    const f = await fixture()
    try {
      f.agentExecution.id = 'execution-agent'
      const started = CiRunOutputSchema.parse((await f.call('ci_run', { suite: 'unit', commandId: 'agent-ci' })).result.structuredContent)
      expect(f.snapshotCalls).toEqual([{ hostRef: { kind: 'device', mainId: f.agent.mainId, deviceId: f.agent.deviceId },
        path: '/home/laptop/root/x/tree', baseCommit: 'b'.repeat(40) }])
      expect(f.approvals.at(-1)).toMatchObject({ snapshot: { commit: 'c'.repeat(40), baseCommit: 'b'.repeat(40) } })
      expect(f.enqueued.at(-1)).toMatchObject({ placementOverride: { kind: 'prefer',
        hostRef: { kind: 'device', mainId: f.agent.mainId, deviceId: f.agent.deviceId } } })
      const read = CiGetOutputSchema.parse((await f.call('ci_get', { ticketId: started.ticketId })).result.structuredContent)
      expect(read.queue.definition.spec.source.commit).toBe('c'.repeat(40))
      const initiatingAgent = { workflowId: 'workflow', runId: 'run', agentId: 'agent', executionId: 'execution-agent' }
      expect(read.queue).toMatchObject({ workflow: null, initiatingAgent })
      f.services.ci = f.createCi()
      const persisted = CiGetOutputSchema.parse((await f.call('ci_get', {
        workspaceId: f.workspaceId, ticketId: started.ticketId,
      }, 'operator')).result.structuredContent)
      expect(persisted.queue.initiatingAgent).toEqual(initiatingAgent)
      f.complete()
      const finished = CiGetOutputSchema.parse((await f.call('ci_get', {
        workspaceId: f.workspaceId, ticketId: started.ticketId,
      }, 'operator')).result.structuredContent)
      expect(finished.queue).toMatchObject({ state: 'accepted', workflow: null, initiatingAgent })


      // An explicit commit is tested as given, still preferring the Agent's computer.
      await f.call('ci_run', { suite: 'unit', commandId: 'agent-ci-commit', commit: 'd'.repeat(40) })
      expect(f.snapshotCalls).toHaveLength(1)
    } finally { await f.app.close() }
  })

  it('runs and reads CI with equivalent scoped Operator grants', async () => {
    const f = await fixture()
    try {
      const start = await f.call('ci_run', { workspaceId: f.workspaceId, suite: 'unit', commandId: 'operator-command' }, 'operator')
      const result = CiRunOutputSchema.parse(start.result.structuredContent)
      const get = await f.call('ci_get', { workspaceId: f.workspaceId, ticketId: result.ticketId }, 'operator')
      expect(CiGetOutputSchema.parse(get.result.structuredContent).queue.principalId).toBe(f.operator.id)
    } finally { await f.app.close() }
  })
})
