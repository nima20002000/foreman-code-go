import { DEFAULT_MANAGEMENT_ACTIONS, type ManagementAction } from '@foreman-code/contracts/management'

/** Omitted --access preserves the existing CLI behavior; explicit read-only never gains mutations. */
export function credentialActions(access: 'manage' | 'read-only' = 'manage'): ManagementAction[] {
  return access === 'read-only' ? DEFAULT_MANAGEMENT_ACTIONS.filter((action) => action.endsWith(':read')) : [...DEFAULT_MANAGEMENT_ACTIONS]
}
