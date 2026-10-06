import { join } from 'node:path'
import type { MaterializationReceipt } from '@foreman-code/contracts/source-materialization'

export function sourceWorkingTreeId(receipt: MaterializationReceipt): string {
  return receipt.sharedTree?.id ?? receipt.materializationId
}

export function sourceWorkingTreePath(receipt: MaterializationReceipt): string {
  return join(receipt.binding.canonicalPath, sourceWorkingTreeId(receipt), 'tree')
}
