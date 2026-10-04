import { expect, it, vi } from 'vitest'
import type { SourceMaterializationRecord, SourceRootRecord } from '@foreman-code/contracts/source-admission'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { assertDeviceHostInstallation } from '../devices/hostAuthorization.js'
import { authorizeClosedSourceRelease } from './operationAuthority.js'
vi.mock('../devices/hostAuthorization.js', () => ({ assertDeviceHostInstallation: vi.fn() }))
function fixture() {
  const binding = { workspaceId: 'actual-workspace', mainId: 'actual-main', workerInstallationId: 'actual-install' }
  const root = { binding, selection: { hostRef: { kind: 'device', mainId: 'actual-main', deviceId: 'actual-device' },
    rootPolicyId: 'actual-policy', rootPolicyRevision: '1' }, registration: { keyRevision: 3, authorizationRevision: 4 } } as SourceRootRecord
  const record = { receipt: { binding }, rootPolicyId: 'actual-policy', rootPolicyRevision: '1' } as SourceMaterializationRecord
  const query = vi.fn(async () => ({ rows: [{}], rowCount: 1 }))
  return { root, record, query, sql: { query } as unknown as GraphSqlClient }
}
it('permits original terminal cleanup from positive Main closure and current exact device without regranting Run execution', async () => {
  const f = fixture(), closure = vi.fn(async () => true)
  vi.mocked(assertDeviceHostInstallation).mockResolvedValue({ keyRevision: 3, authorizationRevision: 4 } as never)
  await expect(authorizeClosedSourceRelease(f.sql, f.root, f.record, closure)).resolves.toBeUndefined()
  expect(closure).toHaveBeenCalledWith(f.sql, f.record)
  expect(assertDeviceHostInstallation).toHaveBeenCalledWith(f.sql, f.root.selection.hostRef, 'actual-install')
})
it('holds uncertain physical ownership without touching device or filesystem authority', async () => {
  const f = fixture(); vi.mocked(assertDeviceHostInstallation).mockClear()
  await expect(authorizeClosedSourceRelease(f.sql, f.root, f.record, async () => false)).rejects.toMatchObject({ code: 'SOURCE_EXECUTION_UNCERTAIN' })
  expect(f.query).not.toHaveBeenCalled(); expect(assertDeviceHostInstallation).not.toHaveBeenCalled()
})
it('denies revoked device and changed root even with positive Main closure', async () => {
  const f = fixture(); vi.mocked(assertDeviceHostInstallation).mockRejectedValue(new Error('revoked device'))
  await expect(authorizeClosedSourceRelease(f.sql, f.root, f.record, async () => true)).rejects.toThrow('revoked device')
  await expect(authorizeClosedSourceRelease(f.sql, f.root, { ...f.record, rootPolicyRevision: '2' }, async () => true)).rejects.toMatchObject({ code: 'SOURCE_EXECUTION_UNCERTAIN' })
  vi.mocked(assertDeviceHostInstallation).mockResolvedValue({ keyRevision: 3, authorizationRevision: 5 } as never)
  await expect(authorizeClosedSourceRelease(f.sql, f.root, f.record, async () => true)).rejects.toMatchObject({ code: 'SOURCE_CONNECTION_CONFLICT' })
})
