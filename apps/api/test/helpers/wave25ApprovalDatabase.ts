import { vi } from 'vitest'
import { object } from '../../src/modules/harnesses/opencodeProtocol.js'
import { PostgresCommandCoordinator } from '../../src/modules/commands/postgres.js'
import { br1002OpenCodeRuntime } from './wave25Br1002OpenCodeRuntime.js'
import { deferred } from './wave25Agent3.js'

/** Current typed Save/Start and real OpenCode adapter capture. Only external
 * HTTP/SSE transport and filesystem qualification are deterministic fixtures. */
export async function approvalDatabase() {
  const runtime = await br1002OpenCodeRuntime('orchestrator')
  const reconcile = vi.spyOn(runtime.native.reviewers, 'reconcile').mockResolvedValue(undefined)
  const live = deferred<void>(), release = deferred<void>()
  const issuance = vi.spyOn(runtime.credentials, 'issueForReviewer')
  let dispatch: Promise<unknown> | undefined
  const append = runtime.repository.coordination.appendReviewNativeEvent.bind(runtime.repository.coordination)
  const capture = vi.spyOn(runtime.repository.coordination, 'appendReviewNativeEvent').mockImplementation(async (...args) => {
    await append(...args)
    if (args[2]?.live && !args[1].connectionId?.startsWith('history-') && args[1].type === 'message.updated' && object(args[1].payload.info).role === 'user') {
      live.resolve(); await release.promise
    }
  })
  async function close() {
    release.resolve()
    await runtime.native.reviewers.shutdown()
    await dispatch?.catch(() => undefined)
    capture.mockRestore(); reconcile.mockRestore(); issuance.mockRestore()
    await runtime.close()
  }
  try {
    await runtime.engine.start(runtime.f.run.id)
    const [interaction] = await runtime.pending()
    if (!interaction?.approval.designatedOrchestratorAgentId) throw new Error('Expected original routed approval')
    const queued = await runtime.repository.coordination.findReviewJob(interaction.id, interaction.approval.designatedOrchestratorAgentId)
    if (!queued) throw new Error('Expected coordinator review job')
    dispatch = runtime.native.reviewers.dispatchNext(queued.reviewerAgentId, 'approval-consumer')
    void dispatch.catch(() => undefined)
    await Promise.race([live.promise, dispatch.then(() => { throw new Error('Review ended before acknowledgement') })])
    const executions = (await runtime.runs.listRepeatExecutions(runtime.f.run.id)).map((row) => row.execution)
    const reviewer = executions.find((e) => e.agentId === queued.reviewerAgentId)!
    const requester = executions.find((e) => e.id === interaction.executionId)!
    const job = (await runtime.repository.coordination.findReviewJob(interaction.id, reviewer.agentId))!
    const issued = issuance.mock.results.at(-1)
    if (issued?.type !== 'return') throw new Error('Expected actual dispatcher reviewer credential')
    const credential = await issued.value
    const principal = await runtime.access.authenticate(credential.environment.variables.GRAPHQL_MCP_TOKEN, 'worker')
    return { ...runtime, pool: runtime.db.pool, close, interaction, reviewer, requester, job, credential, principal,
      commands: new PostgresCommandCoordinator(runtime.db.pool),
      version: runtime.f.version, run: runtime.f.run, scope: runtime.f.scope,
      async settle() {
        const server = runtime.servers.get(reviewer.id)!
        server.finishFromHistory(job.correlationId, job.nativeSessionId)
        server.emit('session.idle', { sessionID: job.nativeSessionId }); release.resolve(); await dispatch
      },
    }
  } catch (error) { await close(); throw error }
}
