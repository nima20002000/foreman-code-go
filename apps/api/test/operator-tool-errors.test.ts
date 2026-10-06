import { expect, it, vi } from 'vitest'
import { invokeOperatorTool } from '../src/mcp/operator/invoke.js'
import type { OperatorRequestContext } from '../src/mcp/operator/types.js'
import { DomainError } from '../src/modules/errors.js'

const log = vi.hoisted(() => ({ error: vi.fn() }))
vi.mock('../src/infrastructure/logger.js', () => ({ componentLogger: () => log }))

function context() {
  const recordDenied = vi.fn(async () => undefined)
  return { recordDenied, value: {
    principal: { id: 'operator' }, services: { commands: { recordDenied } },
  } as unknown as OperatorRequestContext }
}

it('logs the failure location and code without exposing private error text or tool arguments', async () => {
  log.error.mockClear()
  const error = Object.assign(new Error('private-provider-credential\nprivate-multiline-credential'), {
    code: 'CLI_CHECK_REJECTED',
  })
  const result = await invokeOperatorTool(context().value, 'harness_qualification_run', async () => { throw error })
  expect(result).toMatchObject({ isError: true, content: [{ type: 'text', text: JSON.stringify({
    error: { code: 'INTERNAL_ERROR', message: 'The Operator service could not complete the request.' },
  }) }] })
  expect(log.error).toHaveBeenCalledOnce()
  const [diagnostic, message] = log.error.mock.calls[0]!
  expect(diagnostic).toMatchObject({ tool: 'harness_qualification_run', errorType: 'Error',
    errorCode: 'CLI_CHECK_REJECTED' })
  expect(diagnostic.stackFrames.length).toBeGreaterThan(0)
  expect(message).toBe('Operator tool failed')
  expect(JSON.stringify(diagnostic)).not.toContain('private-provider-credential')
  expect(JSON.stringify(diagnostic)).not.toContain('private-multiline-credential')
})

it('retains permission-denial audit and public domain errors', async () => {
  log.error.mockClear()
  const caller = context()
  const result = await invokeOperatorTool(caller.value, 'harness_qualification_run', async () => {
    throw new DomainError('ACCESS_DENIED', 'Required permission is missing.', 403)
  })
  expect(caller.recordDenied).toHaveBeenCalledWith('operator', 'mcp', 'harness_qualification_run',
    'mcp:harness_qualification_run')
  expect(result).toMatchObject({ isError: true, content: [{ type: 'text', text: JSON.stringify({
    error: { code: 'ACCESS_DENIED', message: 'Required permission is missing.' },
  }) }] })
  expect(log.error).not.toHaveBeenCalled()
})
