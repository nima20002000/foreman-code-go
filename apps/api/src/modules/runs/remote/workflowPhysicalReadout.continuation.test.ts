import { expect, it, vi } from 'vitest'
import type { NativeLaunchObservation } from '../../harnesses/recovery/processRegistry.js'
import { REMOTE_PHYSICAL_CONTINUATION_LIMIT } from '@foreman-code/contracts/remote-workflow-physical'
import { deviceApplicationFailure } from '../../devices/deviceApplicationError.js'
import { physicalFixture } from './__tests__/installedWorkflowHost.js'
import {
  InstalledWorkflowPhysicalReadouts,
  pagePhysicalReadout,
  readPhysicalReadout,
  remoteWorkflowSourceDigest,
} from './workflowPhysicalReadout.js'

async function fixture() {
  const f = await physicalFixture()
  const now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
  const history = { ...f.source.history, events: [{ sequence: 1, type: 'native.notification',
    occurredAt: new Date(now).toISOString(), payload: { text: 'output'.repeat(55_000) } }] }
  const source = { type: 'history' as const, history }
  const readouts = new InstalledWorkflowPhysicalReadouts()
  let observation: NativeLaunchObservation = f.captured.launch
  const authorize = vi.fn(async () => {})
  const remember = () => readouts.remember({ readout: { ...f.readout, history,
    expiresAt: new Date(Date.now() + 60_000).toISOString() }, placement: f.placement, source,
    leaseExpiresAt: '2099-01-01T00:00:00.000Z', assertOwnerCurrent: authorize, assertCurrent: authorize,
    observe: () => observation, closure: () => observation.lifecycle === 'closed' ? observation : null })
  remember()
  const selector = { intent: f.intent, placement: f.placement, receiptSequence: f.readout.receipt.sequence,
    sourceDigest: remoteWorkflowSourceDigest(source) }
  return { ...f, now, clock, readouts, remember, selector, authorize,
    closeNative: () => { observation = { ...observation, lifecycle: 'closed', closureEvidence: 'cgroup_v2_empty' } },
    close: async () => { readouts.clear(); clock.mockRestore(); await f.sqlConnection.close() } }
}

it.each(['expiry renewal', 'native closure', 'concurrent refresh'] as const)(
  'keeps one physical snapshot across pages during %s', async change => {
    const f = await fixture()
    try {
      f.clock.mockReturnValue(f.now + 59_000)
      const selected = await f.readouts.read(f.selector)
      const first = pagePhysicalReadout(selected)
      if (!('kind' in first)) throw new Error('Expected a paged physical readout')
      f.clock.mockReturnValue(f.now + 61_000)
      if (change === 'native closure') f.closeNative()
      if (change === 'concurrent refresh') {
        f.remember()
        await f.readouts.read(f.selector)
      }
      const reconstructed = await readPhysicalReadout(first, async metadata =>
        pagePhysicalReadout(await f.readouts.read({ ...f.selector, metadata }), metadata))
      expect(reconstructed).toEqual(selected)
      expect(Date.parse(reconstructed.expiresAt)).toBeGreaterThan(Date.now())
      expect(f.authorize.mock.calls.length).toBeGreaterThan(1)
    } finally {
      await f.close()
    }
  })

it.each(['expired', 'acknowledged', 'purged'] as const)(
  'does not retry an %s physical continuation that cannot be served', async reason => {
    const f = await fixture()
    try {
      const first = pagePhysicalReadout(await f.readouts.read(f.selector))
      if (!('kind' in first)) throw new Error('Expected a paged physical readout')
      const metadata = { digest: first.metadata.digest, offset: Buffer.from(first.metadata.data, 'base64').byteLength }
      if (reason === 'expired') f.clock.mockReturnValue(f.now + 121_000)
      if (reason === 'acknowledged') await f.readouts.ack(f.selector)
      if (reason === 'purged') f.readouts.purge(f.intent.operationId)
      const failure = await f.readouts.read({ ...f.selector, metadata }).then(() => undefined, error => error)
      expect(deviceApplicationFailure(failure)).toEqual({ code: 'transfer-expired', class: 'permanent', retryable: false })
    } finally {
      await f.close()
    }
  })

it('does not serve a saved continuation after authorization is denied', async () => {
  const f = await fixture()
  try {
    const first = pagePhysicalReadout(await f.readouts.read(f.selector))
    if (!('kind' in first)) throw new Error('Expected a paged physical readout')
    const metadata = { digest: first.metadata.digest, offset: Buffer.from(first.metadata.data, 'base64').byteLength }
    const denied = Object.assign(new Error('Access revoked'), { code: 'AUTH_REVOKED' })
    f.authorize.mockRejectedValueOnce(denied)
    await expect(f.readouts.read({ ...f.selector, metadata })).rejects.toBe(denied)
  } finally {
    await f.close()
  }
})

it('codes an oversized physical readout as permanently too large', async () => {
  const f = await physicalFixture()
  try {
    const history = { ...f.source.history, events: [{ sequence: 1, type: 'native.notification',
      occurredAt: new Date().toISOString(), payload: { text: 'x'.repeat(REMOTE_PHYSICAL_CONTINUATION_LIMIT) } }] }
    let failure: unknown
    try {
      pagePhysicalReadout({ ...f.readout, history })
    } catch (error) {
      failure = error
    }
    expect(deviceApplicationFailure(failure)).toEqual({ code: 'payload-too-large', class: 'permanent', retryable: false })
  } finally {
    await f.sqlConnection.close()
  }
})

it('keeps an active paged reply while evicting unread histories oldest first', async () => {
  const f = await fixture()
  try {
    const selected = await f.readouts.read(f.selector)
    const first = pagePhysicalReadout(selected)
    if (!('kind' in first)) throw new Error('Expected a paged physical readout')
    let oldest: typeof f.selector | undefined
    for (let index = 0; index < 140; index++) {
      const history = { ...f.source.history, nextSequence: index }
      const source = { type: 'history' as const, history }
      const selector = { ...f.selector, sourceDigest: remoteWorkflowSourceDigest(source) }
      oldest ??= selector
      f.readouts.remember({ readout: { ...f.readout, history }, placement: f.placement, source,
        leaseExpiresAt: '2099-01-01T00:00:00.000Z', assertOwnerCurrent: f.authorize, assertCurrent: f.authorize,
        observe: () => f.captured.launch, closure: () => null })
    }
    await expect(f.readouts.read(oldest!)).rejects.toMatchObject({ details: { reason: 'not_retained' } })
    expect(await readPhysicalReadout(first, async metadata =>
      pagePhysicalReadout(await f.readouts.read({ ...f.selector, metadata }), metadata))).toEqual(selected)
  } finally {
    await f.close()
  }
})
