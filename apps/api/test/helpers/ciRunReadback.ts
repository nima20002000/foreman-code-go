import { CiGetOutputSchema, type CiGetInput, type CiRunRecord } from '@foreman-code/contracts'
import { expect } from 'vitest'

/** Reads a finished run before comparing its persisted record. */
export async function ciRunReadback(read: (input: CiGetInput) => Promise<unknown>, ticketId: string,
  state: CiRunRecord['state']) {
  await expect.poll(async () => CiGetOutputSchema.parse(await read({ ticketId })).run.state,
    { timeout: 10_000 }).toBe(state)
  return CiGetOutputSchema.parse(await read({ ticketId }))
}
