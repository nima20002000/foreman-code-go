import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { WorkerConversationBinding } from '@foreman-code/contracts/remote-execution-rpc'
import type { NativeLaunchObservation } from '../harnesses/recovery/processRegistry.js'

export function workerConversationProcessDigest(binding: WorkerConversationBinding, launch: NativeLaunchObservation) {
  return commandInputHash({ owner: launch.owner, binding, launchId: launch.launchId, bootId: launch.bootId,
    guardian: launch.guardian, provider: launch.provider, boundary: launch.boundary }).slice('sha256:'.length)
}
