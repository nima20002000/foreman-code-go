import { describe, expect, it } from 'vitest'
import { verificationCapacityFixture } from '../../../test/helpers/verificationCapacityFixture.js'
import { verifyJobQuotaOwnership, type JobQuotaReader } from './quotaOwnership.js'

const profile = verificationCapacityFixture('main')
const pool = profile.measurement!.fingerprint.quotaPool!
const slot = pool.slots[0]!
const observed = { volumeCapacityBytes: 64 * 2 ** 30, volumeCapacityInodes: pool.volumeCapacityInodes,
  projectId: slot.projectId, inheritance: true as const, hardLimitBytes: slot.hardLimitBytes,
  hardInodes: slot.hardInodes, usedBytes: 4096, usedInodes: 1,
  accountingEnabled: true as const, filesystem: slot.filesystem }
function verify(read: JobQuotaReader) {
  return verifyJobQuotaOwnership({ pool, binding: profile.root.binding, slot,
    signal: new AbortController().signal, read })
}
describe('observed project quota ownership', () => {
  it('accepts kernel readback matching the selected independent quota', async () => {
    expect(await verify(async () => observed)).toEqual(observed)
  })
  it.each([
    { projectId: slot.projectId + 1 }, { hardLimitBytes: slot.hardLimitBytes * 2 },
    { hardInodes: slot.hardInodes * 2 }, { usedBytes: slot.hardLimitBytes + 1 },
    { usedInodes: slot.hardInodes + 1 }, { volumeCapacityInodes: pool.volumeCapacityInodes + 1 },
    { filesystem: { ...slot.filesystem, inode: '9999' } },
  ])('rejects changed kernel identity, limits, geometry or usage: %j', async changed => {
    await expect(verify(async () => ({ ...observed, ...changed })))
      .rejects.toMatchObject({ code: 'JOB_QUOTA_CHANGED' })
  })
  it('propagates missing kernel quota access rather than treating declarations as readback', async () => {
    await expect(verify(async () => { throw new Error('quotactl denied') })).rejects.toThrow('quotactl denied')
  })
})
