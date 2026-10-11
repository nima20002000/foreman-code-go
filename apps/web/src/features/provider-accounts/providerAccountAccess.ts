import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { useLocalHumanAccessQuery } from '../../shared/api/settingsExperience'

export function useProviderAccountAccess(target?: DeviceProvisioningTarget, accountId?: string) {
  const query = useLocalHumanAccessQuery()
  const principal = !query.isError ? query.data?.principal : undefined
  const canManageAccount = (selectedAccountId?: string) => Boolean(principal && Date.parse(principal.expiresAt) > Date.now()
    && (['provider_accounts:read', 'provider_accounts:manage'] as const).every(action =>
      principal.grants.some(grant => grant.actions.includes(action)
      && (!grant.scope.mainIds || target && grant.scope.mainIds.includes(target.hostRef.mainId))
      && (!grant.scope.applicationInstallationIds || target
        && grant.scope.applicationInstallationIds.includes(target.applicationInstallationId))
      && (!grant.scope.deviceIds || target?.hostRef.kind === 'device'
        && grant.scope.deviceIds.includes(target.hostRef.deviceId))
      && (!grant.scope.providerAccountIds || selectedAccountId && grant.scope.providerAccountIds.includes(selectedAccountId))
      && !grant.scope.workspaceIds && !grant.scope.workflowIds && !grant.scope.runIds)))
  return { canManage: canManageAccount(accountId), canManageAccount, query }
}
