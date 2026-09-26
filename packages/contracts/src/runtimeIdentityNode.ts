import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import type { RuntimeIdentity } from './runtimeIdentity.js'

export function checkoutIdentity(root: string): string {
  return fingerprint(realpathSync(root))
}
function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
/** Credentials and query parameters are deliberately excluded from public identity. */
export function createRuntimeIdentity(root: string, connectionString: string, installationId: string): RuntimeIdentity {
  const database = new URL(connectionString)
  const checkoutId = checkoutIdentity(root)
  const databaseId = fingerprint(JSON.stringify([
    database.hostname.toLowerCase(), database.port || '5432', decodeURIComponent(database.pathname),
  ]))
  return { checkoutId, databaseId, installationId }
}
