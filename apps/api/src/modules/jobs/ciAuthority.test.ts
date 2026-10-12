import type pg from 'pg'
import { afterEach, expect, it, vi } from 'vitest'
import { ciFixture } from '../../../test/helpers/ciFixture.js'
import * as credentials from '../interactions/wave25/credentialAuthority.js'
import { DomainError } from '../errors.js'
import { CI_RUN_ACTIONS, RunCiAuthority } from './ciAuthority.js'

afterEach(() => vi.restoreAllMocks())

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function fixture() {
  const ci = ciFixture()
  const waiting = deferred()
  const unlocked = deferred()
  let runLocked = true
  let bindingLocked = false
  let live = true
  vi.spyOn(credentials, 'assertWave25WorkerBinding').mockImplementation(async () => {
    if (!live) throw new DomainError('AUTH_REVOKED', 'Worker credential revoked.', 403)
  })
  const lockRun = async () => {
    if (!runLocked) return
    waiting.resolve()
    await unlocked.promise
  }
  const sql = { async query(text: string) {
    if (text === 'commit' || text === 'rollback') bindingLocked = false
    if (text.startsWith('select r.id')) await lockRun()
    if (text.includes('as authorization_principal_id')) {
      if (text.includes('for share of b')) bindingLocked = true
      if (text.includes('for share of b,r')) await lockRun()
      return { rows: live ? [{ workspace_id: ci.workspaceId, workflow_id: 'workflow', run_id: 'run',
        execution_id: 'execution', authorization_principal_id: ci.operator.id }] : [] }
    }
    if (text.includes('from management_principals')) return { rows: [{ ...ci.operator, audience: 'operator',
      expires_at: new Date(ci.operator.expiresAt), revoked_at: null, delegated_from: null }] }
    return { rows: [] }
  }, release() {} }
  const pool = { connect: async () => sql } as unknown as pg.Pool
  const release = () => { runLocked = false; unlocked.resolve() }
  const admitCredentials = async () => {
    if (bindingLocked) throw Object.assign(new Error('Credential admission deadlocked with CI read.'), { code: '40P01' })
    release()
  }
  return { ci, authority: new RunCiAuthority(pool), waiting: waiting.promise, admitCredentials, release,
    revoke: () => { live = false } }
}

it('allows a CI run and Run-first credential admission to finish concurrently', async () => {
  const f = fixture()
  const pending = f.authority.resolve(f.ci.worker, undefined, CI_RUN_ACTIONS)
  try {
    await f.waiting
    await f.admitCredentials()
    expect(await pending).toMatchObject({ workspaceId: f.ci.workspaceId, principal: { id: f.ci.operator.id },
      executionId: 'execution', initiatingAgent: { runId: 'run', executionId: 'execution' } })
  } finally {
    f.release()
    await Promise.allSettled([pending])
  }
})

it('denies a binding revoked while a CI run waits for credential admission', async () => {
  const f = fixture()
  const pending = f.authority.resolve(f.ci.worker, undefined, CI_RUN_ACTIONS)
  const denied = expect(pending).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
  await f.waiting
  f.revoke()
  f.release()
  await denied
})
