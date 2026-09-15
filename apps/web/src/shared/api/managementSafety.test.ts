import { afterEach, expect, it } from 'vitest'
import { CommandAttempt } from './commandAttempt'
import { collectManagementPages } from './managementPaging'
import { assertSession, beginSessionChange, clearProtectedStorage, finishSessionChange, sessionGeneration, sessionSignal } from './sessionBoundary'

afterEach(() => finishSessionChange())
it('F22 follows all pages and reports a complete catalog', async () => {
  const result = await collectManagementPages(async (cursor) => cursor === undefined
    ? { items: ['first'], pageInfo: { nextCursor: 'more' } }
    : { items: ['last'], pageInfo: { nextCursor: null } })
  expect(result).toEqual({ items: ['first', 'last'], pageInfo: { nextCursor: null } })
})
it('F22 rejects repeated cursors instead of returning partial data', async () => {
  await expect(collectManagementPages(async () => ({ items: [], pageInfo: { nextCursor: 'same' } }))).rejects.toThrow('repeated')
})
it('F24 an uncertain command retries the same identity and values', () => {
  const attempt = new CommandAttempt<{ name: string }>()
  const first = attempt.input({ name: 'Workspace' })
  attempt.failed(new Error('Lost response'))
  expect(attempt.input({ name: 'Workspace' })).toEqual(first)
  expect(() => attempt.input({ name: 'Different' })).toThrow('unknown outcome')
  attempt.succeeded()
  expect(attempt.input({ name: 'Different' }).commandId).not.toBe(first.commandId)
})
it('F27 switching aborts old requests and rejects late responses', () => {
  const generation = sessionGeneration(), signal = sessionSignal()
  beginSessionChange()
  expect(signal.aborted).toBe(true)
  expect(() => assertSession(generation)).toThrow('Operator access changed')
})
it('F27 removes protected snapshots without clearing unrelated settings', () => {
  sessionStorage.setItem('graphql-local-agents:workspace-a', 'private')
  sessionStorage.setItem('graphql-deleted-agents:workspace-a', 'private')
  sessionStorage.setItem('test-unrelated-preference', 'keep')
  clearProtectedStorage(sessionStorage)
  expect(sessionStorage.getItem('graphql-local-agents:workspace-a')).toBeNull()
  expect(sessionStorage.getItem('graphql-deleted-agents:workspace-a')).toBeNull()
  expect(sessionStorage.getItem('test-unrelated-preference')).toBe('keep')
  sessionStorage.removeItem('test-unrelated-preference')
})
