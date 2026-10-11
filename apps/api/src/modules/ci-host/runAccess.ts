import type { CiRunRecord } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { DomainError } from '../errors.js'

export function assertCiReadAccess(caller: ManagementPrincipal, executionId: string | undefined, run: CiRunRecord) {
  if (caller.audience === 'worker' && (!executionId || run.initiator.executionId !== executionId)) {
    throw new DomainError('ACCESS_DENIED', 'CI readback is limited to this Agent execution’s requests.', 403)
  }
}
