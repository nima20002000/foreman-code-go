import { componentLogger } from '../diagnostics/logger.js'
import { DomainError } from '../errors.js'

const log = componentLogger('jobs')

export async function pushMirror(push: () => Promise<string>, context: { mirror: string; commit: string }): Promise<void> {
  try {
    await push()
  } catch (error) {
    if (!(error instanceof DomainError) || error.code !== 'CI_CLOUD_FAILED'
      || !/\[remote rejected\][^\r\n]*\(missing necessary objects\)/.test(error.message)) throw error
    // Cleanup or another process can retire advertised refs while Git sends a pack that omits their objects.
    // A new push negotiates again and sends the missing objects from the local snapshot store.
    log.warn({ operation: 'retry CI mirror push', err: error, ...context, attempt: 1 },
      'CI mirror lost advertised objects; retrying push once with fresh negotiation')
    await push()
  }
}
