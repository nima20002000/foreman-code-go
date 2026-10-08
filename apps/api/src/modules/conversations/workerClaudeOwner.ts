import { isDeepStrictEqual } from 'node:util'
import type { NativeSessionReference } from '@foreman-code/contracts'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { WorkerConversationBinding } from '@foreman-code/contracts/remote-execution-rpc'
import type { NativeLaunchObservation, NativeProcessRegistry } from '../harnesses/recovery/processRegistry.js'
import { DomainError } from '../errors.js'
import type { WorkerConversationJournal } from './workerJournal.js'
import { workerConversationProcessDigest } from './workerNativeOwner.js'

export function createWorkerClaudeOwner(input: {
  binding: WorkerConversationBinding
  owner: string
  registry: Pick<NativeProcessRegistry, 'snapshot' | 'closedRegistration'>
  journal: WorkerConversationJournal
  current(): Readonly<DeviceSessionBinding>
}) {
  let launch: NativeLaunchObservation | undefined
  let session: NativeSessionReference | undefined
  let changing: Promise<void> | undefined
  const unavailable = (): never => {
    throw new DomainError('WORKER_CONVERSATION_UNAVAILABLE', 'The original Claude process is unavailable or changed.', 409)
  }
  const currentLaunch = () => {
    const rows = input.registry.snapshot().launches.filter(row => row.owner === input.owner && row.lifecycle === 'active')
    const current = rows.length === 1 ? rows[0] : undefined
    if (!current?.guardian || !current.provider || !current.boundary) return unavailable()
    return current
  }
  const identity = (reference: NativeSessionReference, process: NativeLaunchObservation) => ({
    sessionId: reference.nativeSessionId, processIdentityDigest: workerConversationProcessDigest(input.binding, process),
  })
  return {
    beginOwnerChange() {
      if (changing) unavailable()
      let complete!: () => void
      changing = new Promise<void>(resolve => { complete = resolve })
      return () => { changing = undefined; complete() }
    },
    async nativeOwner(reference: NativeSessionReference) {
      await changing
      const current = currentLaunch()
      if (launch && !isDeepStrictEqual(current, launch) || session && !isDeepStrictEqual(reference, session)) unavailable()
      launch ??= current
      session ??= structuredClone(reference)
      return identity(reference, current)
    },
    async refreshOwner(reference: NativeSessionReference, correlationId?: string) {
      if (!launch) return
      if (!isDeepStrictEqual(reference, session)) unavailable()
      const current = currentLaunch()
      if (isDeepStrictEqual(current, launch)) return
      const closed = input.registry.closedRegistration(input.owner, launch.launchId)
      if (!closed?.closureEvidence || closed.lifecycle !== 'closed'
        || !isDeepStrictEqual(identity(reference, closed), identity(reference, launch))) unavailable()
      const record = await input.journal.read(input.binding)
      if (!isDeepStrictEqual(record?.session, reference)) unavailable()
      await input.journal.recoveredOwner(input.binding, input.current(), identity(reference, launch),
        identity(reference, current), correlationId ? { pendingCorrelationId: correlationId } : undefined)
      launch = current
    },
  }
}
