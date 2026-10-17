import { setTimeout as delay } from 'node:timers/promises'
import { componentLogger } from '../diagnostics/logger.js'
import { DomainError } from '../errors.js'

const log = componentLogger('jobs')

const rejected = (error: unknown, reason: RegExp) => error instanceof DomainError && error.code === 'CI_CLOUD_FAILED'
  && reason.test(error.message)
// GitHub fails ref updates on its side when many CI parts push their refs at once; the same push succeeds shortly after.
const GITHUB_REF_FAILURE = /\[remote rejected\][^\r\n]*\((?:failed|failure)\)|fatal error in commit_refs/
const MISSING_OBJECTS = /\[remote rejected\][^\r\n]*\(missing necessary objects\)/
const ATTEMPTS = 6

export async function pushMirror(push: () => Promise<string>, context: { mirror: string; commit: string }): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await push()
      return
    } catch (error) {
      if (attempt >= ATTEMPTS) throw error
      if (rejected(error, MISSING_OBJECTS) && attempt === 1) {
        // Cleanup or another process can retire advertised refs while Git sends a pack that omits their objects.
        // A new push negotiates again and sends the missing objects from the local snapshot store.
        log.warn({ operation: 'retry CI mirror push', err: error, ...context, attempt },
          'CI mirror lost advertised objects; retrying push once with fresh negotiation')
        continue
      }
      if (!rejected(error, GITHUB_REF_FAILURE)) throw error
      log.warn({ operation: 'retry CI mirror push', err: error, ...context, attempt },
        'GitHub failed the CI mirror ref update; retrying the push')
      // Spread a burst of parts over a few seconds instead of retrying them together.
      await delay(Math.min(500 * 2 ** (attempt - 1), 2_000) + Math.floor(Math.random() * 1000))
    }
  }
}
