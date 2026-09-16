import type { ManagementPrincipal } from '@graphql/contracts/management'

import type { PostgresAccessService } from '../../modules/access/postgres.js'
import type { AppInteractionService } from '../../modules/interactions/app.js'

export interface AppMcpServices {
  access: PostgresAccessService
  interactions: AppInteractionService
}

export interface AppRequestContext {
  principal: ManagementPrincipal
  interactions: AppInteractionService
}
