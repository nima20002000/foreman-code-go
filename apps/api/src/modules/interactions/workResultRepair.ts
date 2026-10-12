import type { ExecutionResult } from '@foreman-code/contracts'
import { parseWorkHandoffResult } from '@foreman-code/contracts/wave25'
import { ZodError } from 'zod'

export function workResultRepairPrompt(result: ExecutionResult, contract: string): string | undefined {
  if (result.outcome !== 'succeeded') return undefined
  try {
    parseWorkHandoffResult(result)
    return undefined
  } catch (error) {
    const issues = error instanceof ZodError ? JSON.stringify(error.issues) : String(error)
    return [
      'Your complete result failed the pinned work-handoff contract.',
      `Validation issues: ${issues}`,
      'Correct the result format and return the complete JSON object again. Preserve your deliverable and findings.',
      'This is a corrective turn in the same execution. Do not repeat the task or perform additional work.',
      'Expected result shape and saved routing constraints:',
      contract,
    ].join('\n')
  }
}
