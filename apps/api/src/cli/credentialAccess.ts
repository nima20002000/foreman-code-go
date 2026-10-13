import { DEFAULT_MANAGEMENT_ACTIONS, type ManagementAction } from '@foreman-code/contracts/management'

/** Read-only credentials retain the narrow read preset. */
export function credentialActions(access: 'manage' | 'read-only' = 'manage'): ManagementAction[] {
  if (access === 'manage') return [...DEFAULT_MANAGEMENT_ACTIONS]
  return DEFAULT_MANAGEMENT_ACTIONS.filter(action => action.endsWith(':read')
    && action !== 'devices:metrics:read' && action !== 'provider_accounts:read')
}
