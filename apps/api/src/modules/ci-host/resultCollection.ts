import type pg from 'pg'
import type { CiHostReply, CiHostRun, CiRunRecord } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import { componentLogger } from '../diagnostics/logger.js'
import type { HostCiComputer, HostCiEndpoint } from './service.js'
import { serializeCiJson } from './text.js'
import { ciExecutionRunId } from './executionAttempt.js'

const log = componentLogger('jobs')

export async function collectCiResults(pool: pg.Pool, endpoint: HostCiEndpoint, computer: HostCiComputer,
  run: CiRunRecord, reply: Extract<CiHostReply, { operation: 'read' }>) {
  if (!['unit', 'integration'].includes(run.suite)) return { run: reply.run, durations: reply.durations }
  let results: Extract<CiHostReply, { operation: 'read' }> | undefined
  let collection: CiHostRun['collection'] = 'pending'
  try {
    const fetched = await endpoint.request(computer, { operation: 'read', runId: ciExecutionRunId(run),
      afterOffset: 0, maxBytes: 1, testResults: true, durations: true })
    if (fetched.operation === 'read') {
      results = fetched
      if (fetched.testResults) {
        await pool.query('update ci_runs set test_results=$2::jsonb where id=$1', [run.id, serializeCiJson(fetched.testResults)])
        collection = fetched.run.collection === 'pending' ? 'pending' : 'complete'
      } else if (fetched.run.collection === 'unsupported') {
        collection = 'unsupported'
      }
    }
  } catch (error) {
    const unsupported = error instanceof DomainError && (error.code === 'CI_TEST_RESULTS_UNSUPPORTED'
      || error.status === 400 && /testResults/.test(error.message))
    if (unsupported) collection = 'unsupported'
    else log.warn({ err: error, runId: run.id }, 'CI result collection remains pending')
  }
  return { run: { ...reply.run, collection }, durations: results?.durations ?? reply.durations }
}
