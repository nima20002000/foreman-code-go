import { loadProductEnvFile } from '@foreman-code/contracts/product-environment-node'

import type { ManagementGrant } from '@foreman-code/contracts/management'
import { credentialActions } from './credentialAccess.js'

import { loadConfig } from '../config.js'
import { createDatabase } from '../infrastructure/database.js'
import { PostgresAccessService } from '../modules/access/postgres.js'

import { parseCredentialArguments } from './operatorCredentialArguments.js'

async function main() {
  const input = parseCredentialArguments(process.argv.slice(2))
  try { loadProductEnvFile() } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error
  }
  const config = loadConfig(process.env)
  const database = createDatabase(config.database)
  try {
    await database.migrate()
    const access = new PostgresAccessService(database.pool)
    if (input.command === 'revoke') {
      const { principalId } = input
      if (!await access.revoke(principalId)) throw new Error(`Principal '${principalId}' was not found.`)
      process.stdout.write(`Revoked ${principalId}\n`)
      return
    }
    const { name, audience, days, workspaceId, computerMetrics } = input
    const grant: ManagementGrant = {
      actions: credentialActions(input.access),
      scope: workspaceId ? { workspaceIds: [workspaceId] } : {},
    }
    const issued = await access.issue({
      // Computer reads need their own unscoped grant, even beside a workspace-scoped one.
      name, audience, grants: computerMetrics ? [grant, { actions: ['devices:metrics:read'], scope: {} }] : [grant], expiresAt: new Date(Date.now() + days * 86_400_000),
    })
    process.stdout.write(`Principal: ${issued.principal.id}\nAudience: ${issued.principal.audience}\nExpires: ${issued.principal.expiresAt}\nToken (shown once): ${issued.token}\n`)
  } finally { await database.close() }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Credential command failed.'}\n`)
  process.exitCode = 1
})
