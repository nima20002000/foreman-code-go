import { ManagementActionSchema, type ManagementAction } from '@graphql/contracts/management'

/** Omitted --access preserves the existing CLI behavior; explicit read-only never gains mutations. */
export function credentialActions(access: 'manage' | 'read-only' = 'manage'): ManagementAction[] {
  return access === 'read-only' ? ManagementActionSchema.options.filter((action) => action.endsWith(':read')) : [...ManagementActionSchema.options]
}
