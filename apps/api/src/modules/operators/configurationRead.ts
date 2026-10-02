import type { ManagementPrincipal } from '@graphql/contracts/management'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { requireAuthorization } from '../access/policy.js'
import { DomainError } from '../errors.js'

/** The public default is harness metadata. Other immutable configuration pins
 * are readable only through the caller's actual owned conversation history. */
export async function authorizeOperatorConfigurationRead(database: GraphSqlClient, principal: ManagementPrincipal, configurationVersionId: string): Promise<void> {
  requireAuthorization(principal, 'harnesses:read')
  const current = (await database.query<{ current_configuration_version_id: string }>(
    'select current_configuration_version_id from application_operators where id=$1', ['application-operator'])).rows[0]
  if (current?.current_configuration_version_id === configurationVersionId) return
  requireAuthorization(principal, 'operator_chat:read')
  const owned = await database.query(`select 1 from operator_conversations c
    where c.kind='operator' and c.owner_principal_id=$1 and c.deleted_at is null
      and (c.operator_configuration_version_id=$2 or exists(select 1 from operator_conversation_turns t
        where t.conversation_id=c.id and t.operator_configuration_version_id=$2)) limit 1`, [principal.id, configurationVersionId])
  if (!owned.rows.length) throw new DomainError('ACCESS_DENIED', 'This Operator configuration is not readable in the caller’s conversation context.', 403)
}
