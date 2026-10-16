import type { SavedRunDetails } from '@foreman-code/contracts/wave25'
import { readUntil } from './observableCondition.js'

export function waitForHandoffCompletion(
  fixture: { details(): Promise<SavedRunDetails> },
  description: string,
): Promise<SavedRunDetails> {
  return readUntil(fixture.details, details => details.run.executionState === 'completed',
    { timeoutMs: 30_000, description })
}
