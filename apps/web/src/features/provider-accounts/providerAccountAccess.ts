import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { sameDeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import type { ProviderAccountBinding } from '@foreman-code/contracts/provider-accounts'
import { useProviderAccountEligibility, useProviderAccountTargets } from './providerAccountDiscovery'

export function useProviderAccountAccess(target?: DeviceProvisioningTarget, binding?: ProviderAccountBinding) {
  const discovery = useProviderAccountTargets()
  const eligibility = useProviderAccountEligibility(binding)
  const selected = !discovery.isError ? discovery.data?.targets.find(item => target
    && sameDeviceProvisioningTarget(item.target, target)) : undefined
  const canManage = binding ? !eligibility.isError && eligibility.data?.canManage === true : selected?.canManage === true
  return { canManage, target: selected, eligibility, discovery }
}
