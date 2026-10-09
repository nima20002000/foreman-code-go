import { expect, it, vi } from 'vitest'
import type pg from 'pg'
import { reconcileFailedCaptures } from './failedCaptureCleanup.js'

function fixture() {
  const state = { locked: true, approvalState: 'failed', reservationState: 'uncertain', accountedBytes: 170_000_000 }
  const reservation = {
    reservationId: 'reservation', scopeId: 'scope', ownerKind: 'capture', ownerId: 'snapshot',
    reservedBytes: state.accountedBytes,
  }
  const candidate = { snapshot_id: 'snapshot', requested_by: 'principal', command_id: 'command' }
  const query = vi.fn(async (text: string, values?: unknown[]) => {
    if (text.includes('pg_try_advisory_xact_lock')) return { rows: [{ locked: state.locked }], rowCount: 1 }
    if (text.includes('select r.record')) return { rows: [{ record: reservation, state: state.approvalState,
      workspace_id: 'workspace' }], rowCount: 1 }
    if (text.startsWith('update source_storage_reservations')) {
      state.reservationState = String(values![1])
      state.accountedBytes = Number(values![2])
    }
    return { rows: [], rowCount: 1 }
  })
  const release = vi.fn()
  const pool = {
    query: async () => ({ rows: [candidate] }),
    connect: async () => ({ query, release }),
  } as unknown as pg.Pool
  const store = { retainedCaptureBytes: vi.fn(async () => 8192),
    manifest: vi.fn(async (): Promise<never> => { throw Object.assign(new Error('Capture not finalized'), { code: 'ENOENT' }) }) }
  const report = vi.fn()
  return { pool, state, query, release, store, report }
}

it('corrects a failed capture reservation under its original command lock and retains metadata', async () => {
  const f = fixture()
  await reconcileFailedCaptures(f.pool, f.store, f.report)
  expect(f.store.retainedCaptureBytes).toHaveBeenCalledExactlyOnceWith('snapshot')
  expect(f.state).toMatchObject({ reservationState: 'retained', accountedBytes: 24_576 })
  expect(f.report).not.toHaveBeenCalled()
  expect(f.release).toHaveBeenCalledOnce()
})

it('keeps the full reservation while the original capture command still owns its lock', async () => {
  const f = fixture()
  f.state.locked = false
  await reconcileFailedCaptures(f.pool, f.store, f.report)
  expect(f.store.retainedCaptureBytes).not.toHaveBeenCalled()
  expect(f.state.accountedBytes).toBe(170_000_000)
})

it('keeps the reservation and reports failed physical accounting', async () => {
  const f = fixture()
  f.store.retainedCaptureBytes.mockRejectedValue(new Error('unsafe retained file'))
  await reconcileFailedCaptures(f.pool, f.store, f.report)
  expect(f.state.reservationState).toBe('uncertain')
  expect(f.state.accountedBytes).toBe(170_000_000)
  expect(f.report).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'unsafe retained file' }))
})

it('keeps an expired capture fully charged without positive filesystem finalization', async () => {
  const f = fixture()
  f.state.approvalState = 'capturing'
  f.state.reservationState = 'preparing'
  await reconcileFailedCaptures(f.pool, f.store, f.report)
  expect(f.store.manifest).toHaveBeenCalledExactlyOnceWith('snapshot')
  expect(f.store.retainedCaptureBytes).not.toHaveBeenCalled()
  expect(f.state).toMatchObject({ reservationState: 'preparing', accountedBytes: 170_000_000 })
  expect(f.report).not.toHaveBeenCalled()
})
