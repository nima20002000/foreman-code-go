import { expect, it, vi } from 'vitest'
import type { NativeOutputCallCapture } from '../../harnesses/port.js'
import { DomainError } from '../../errors.js'
import { admitNativeOutputContext } from './localOutputContext.js'

function callback() {
  const descriptor: NativeOutputCallCapture['descriptor'] = {
    nativeSessionId: 'original-session', rootTurnId: 'original-turn', assistantMessageId: 'original-assistant',
    callId: 'original-call', toolName: 'files.native_output_create', nativeToolName: 'graphql_files_native_output_create',
    inputDigest: 'original-input',
  }
  let current = true
  const native: NativeOutputCallCapture = { descriptor, effectivePolicy: 'ask', assertCurrent() {
    if (!current) throw new DomainError('SESSION_LANE_LEASE_LOST', 'The observer released its writer.', 409)
  } }
  return { native, release: () => { current = false } }
}

it('re-inspects the same running callback after its writer is released during context admission', async () => {
  const previous = callback()
  const successor = callback()
  const accepted = {} as Awaited<ReturnType<Parameters<typeof admitNativeOutputContext>[0]['context']>>
  const capture = vi.fn().mockResolvedValueOnce(previous.native).mockResolvedValueOnce(successor.native)
  const context = vi.fn().mockImplementationOnce(async () => {
    previous.release()
    throw new DomainError('NATIVE_ARTIFACT_AUTHORITY_DENIED', 'Writer not active.', 403)
  }).mockResolvedValueOnce(accepted)
  const checkDeclaration = vi.fn(async () => undefined)
  expect(await admitNativeOutputContext({ signal: new AbortController().signal, capture, context, checkDeclaration }))
    .toEqual({ native: successor.native, accepted })
  expect(capture).toHaveBeenCalledTimes(2)
  expect(context).toHaveBeenCalledTimes(2)
  expect(checkDeclaration).toHaveBeenCalledOnce()
})

it('does not retry a genuine context denial while the captured writer remains current', async () => {
  const original = callback()
  const denied = new DomainError('ACCESS_DENIED', 'Read-only owner.', 403)
  const capture = vi.fn(async () => original.native)
  const checkDeclaration = vi.fn(async () => undefined)
  await expect(admitNativeOutputContext({ signal: new AbortController().signal, capture,
    context: async () => { throw denied }, checkDeclaration })).rejects.toBe(denied)
  expect(capture).toHaveBeenCalledOnce()
  expect(checkDeclaration).not.toHaveBeenCalled()
})

it('rejects a different callback rather than applying the old command to another native call', async () => {
  const previous = callback()
  const successor = callback()
  successor.native.descriptor = { ...successor.native.descriptor, callId: 'another-call' }
  const capture = vi.fn().mockResolvedValueOnce(previous.native).mockResolvedValueOnce(successor.native)
  await expect(admitNativeOutputContext({ signal: new AbortController().signal, capture,
    context: async () => { previous.release(); throw new DomainError('NATIVE_ARTIFACT_AUTHORITY_DENIED', 'Writer lost.', 403) },
    checkDeclaration: async () => undefined })).rejects.toMatchObject({ code: 'WORKFLOW_NATIVE_OUTPUT_CALL_CONFLICT' })
})

it('preserves declaration revocation and cancellation during a writer handoff', async () => {
  for (const boundary of ['declaration', 'cancellation']) {
    const previous = callback()
    const stopped = new AbortController()
    const revoked = new DomainError('AUTH_REVOKED', 'The grant was revoked.', 403)
    const capture = vi.fn(async () => previous.native)
    await expect(admitNativeOutputContext({ signal: stopped.signal, capture,
      context: async () => {
        previous.release()
        if (boundary === 'cancellation') stopped.abort(revoked)
        throw new DomainError('NATIVE_ARTIFACT_AUTHORITY_DENIED', 'Writer lost.', 403)
      }, checkDeclaration: async () => { throw revoked } })).rejects.toBe(revoked)
    expect(capture).toHaveBeenCalledOnce()
  }
})

it('does not reinterpret a changed native process as a writer handoff', async () => {
  const original = callback()
  const disposed = new DomainError('NATIVE_MANAGER_DISPOSED', 'The native process closed.', 409)
  original.native.assertCurrent = () => { throw disposed }
  const capture = vi.fn(async () => original.native)
  const context = vi.fn()
  await expect(admitNativeOutputContext({ signal: new AbortController().signal, capture, context,
    checkDeclaration: async () => undefined })).rejects.toBe(disposed)
  expect(capture).toHaveBeenCalledOnce()
  expect(context).not.toHaveBeenCalled()
})
