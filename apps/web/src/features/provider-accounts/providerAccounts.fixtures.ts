import {
  ProviderAccountSchema, ProviderAccountAuthenticationOperationSchema,
  type ProviderAccountBinding, type ProviderAccountAuthenticationOperation,
} from '@foreman-code/contracts/provider-accounts'
import { mockRuntimeIdentity } from '../../shared/mocks/handlers'

export const accountId = '30000000-0000-4000-8000-000000000001'
export const secondAccountId = '30000000-0000-4000-8000-000000000002'
export const operationId = '30000000-0000-4000-8000-000000000003'
export const observedAt = '2026-10-01T12:00:00.000Z'
export const accountTarget = { hostRef: { kind: 'main' as const, mainId: mockRuntimeIdentity.installationId },
  applicationInstallationId: mockRuntimeIdentity.installationId, keyRevision: null, authorizationRevision: null }
export function accountBinding(id = accountId): ProviderAccountBinding {
  return { kind: 'slot', accountId: id, provider: 'codex', target: accountTarget,
    profileRef: id, bindingRevision: 1, subject: null }
}
export function observedAccount(id = accountId) {
  return ProviderAccountSchema.parse({ id, provider: 'codex', name: id === accountId ? 'Original account' : 'Other account',
    authMode: 'subscription', isDefault: id === accountId, status: 'signed-out', identity: 'display@example.test',
    revision: 1, binding: accountBinding(id), removedAt: null,
    observation: { bindingRevision: 1, generation: 1, sequence: 1, observedAt,
      status: 'signed-out', identity: 'display@example.test', subject: null, readiness: 'sign-in-required' } })
}
export function authenticationOperation(overrides: Partial<ProviderAccountAuthenticationOperation> = {}) {
  return ProviderAccountAuthenticationOperationSchema.parse({ id: operationId, commandId: 'original-auth-command',
    inputHash: `sha256:${'a'.repeat(64)}`, binding: accountBinding(), intent: 'sign-in', state: 'awaiting-human',
    revision: 1, generation: 1, nativeSequence: 1, cancelRequested: false, nativeClosed: false,
    createdAt: observedAt, updatedAt: observedAt, expiresAt: '2026-10-01T12:15:00.000Z',
    humanActionRequired: true, ...overrides })
}
