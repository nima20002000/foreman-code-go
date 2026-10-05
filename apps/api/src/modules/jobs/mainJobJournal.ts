import { lstat } from 'node:fs/promises'
import { DomainError } from '../errors.js'
import { RemoteOperationJournal } from '../runs/remote/operationJournal.js'
import type { JobSql } from './repository.js'

/** First installation has no operations to recover; missing retained history never authorizes a fresh journal. */
export async function openMainJobJournal(input: {
  sql: JobSql
  path: string
  mainId: string
  initialization: 'bootstrap' | 'existing-only'
}): Promise<RemoteOperationJournal> {
  const existing = await lstat(input.path).catch(error => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (existing) return RemoteOperationJournal.open(input.path)
  if (input.initialization === 'existing-only') throw recoveryRequired()
  const row = (await input.sql.query<{ owned: boolean }>(`select
    exists(select 1 from job_executions where accepted_spec #>> '{target,hostRef,kind}'='main'
      and accepted_spec #>> '{target,mainInstallationId}'=$1)
    or exists(select 1 from job_runtime_qualification_approvals
      where native_admission #>> '{hostRef,kind}'='main'
        and native_admission->>'mainInstallationId'=$1) as owned`, [input.mainId])).rows[0]
  if (!row || row.owned) throw recoveryRequired()
  return RemoteOperationJournal.open(input.path, { initializeNewInstallation: true })
}

function recoveryRequired() {
  return new DomainError('JOB_JOURNAL_RECOVERY_REQUIRED',
    'The Main Job journal is missing. Recover its original operation history before starting more Jobs.', 409)
}
