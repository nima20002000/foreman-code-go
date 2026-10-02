import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import type { DeviceExtensionContext, DeviceExtensionRegistration } from '../../devices/deviceApplicationChannel.js'
import { createMainWorkflowArtifactTransferExtension } from './workflowArtifactTransferProduction.js'
function fixture() {
  const artifact = vi.fn(async () => ({ payload: 'artifact' })), source = vi.fn(async () => ({ payload: 'source' }))
  const receiver = { ownsTransfer: vi.fn(async () => true), extension: { handle: artifact } as unknown as DeviceExtensionRegistration }
  const extension = createMainWorkflowArtifactTransferExtension(() => receiver, { handle: source } as unknown as DeviceExtensionRegistration)
  const frame = { binding: { original: true }, bytes: new Uint8Array([1, 2]), signal: new AbortController().signal } as unknown as DeviceExtensionContext
  return { artifact, source, receiver, extension, frame, request: { method: 'append', transferId: randomUUID() } }
}
it('routes ID-only frames to their original artifact receiver with the real frame unchanged', async () => {
  const f = fixture()
  await expect(f.extension.handle!(f.request, f.frame)).resolves.toEqual({ payload: 'artifact' })
  expect(f.receiver.ownsTransfer).toHaveBeenCalledExactlyOnceWith(f.request.transferId)
  expect(f.artifact).toHaveBeenCalledExactlyOnceWith(f.request, f.frame)
  expect(f.source).not.toHaveBeenCalled()
  expect(f.extension.role).toBe('duplex')
})
it('preserves the existing source receiver for transfers outside the artifact admission ledger', async () => {
  const f = fixture(); f.receiver.ownsTransfer.mockResolvedValue(false)
  await expect(f.extension.handle!(f.request, f.frame)).resolves.toEqual({ payload: 'source' })
  expect(f.source).toHaveBeenCalledExactlyOnceWith(f.request, f.frame)
  expect(f.artifact).not.toHaveBeenCalled()
})
it.each(['membership', 'artifact'])('does not fall back after an original %s failure', async kind => {
  const f = fixture()
  if (kind === 'membership') f.receiver.ownsTransfer.mockRejectedValue(new Error('membership unavailable'))
  else f.artifact.mockRejectedValue(new Error('original grant revoked'))
  await expect(f.extension.handle!(f.request, f.frame)).rejects.toThrow()
  expect(f.source).not.toHaveBeenCalled()
})
it('does not classify or deliver an already aborted frame', async () => {
  const f = fixture(), abort = new AbortController(); abort.abort()
  await expect(f.extension.handle!(f.request, { ...f.frame, signal: abort.signal })).rejects.toThrow()
  expect(f.receiver.ownsTransfer).not.toHaveBeenCalled()
  expect(f.artifact).not.toHaveBeenCalled(); expect(f.source).not.toHaveBeenCalled()
})
it('keeps absent runtime or absent original source ownership unavailable', async () => {
  const f = fixture()
  await expect(createMainWorkflowArtifactTransferExtension(() => undefined).handle!(f.request, f.frame)).rejects.toThrow('not initialized')
  f.receiver.ownsTransfer.mockResolvedValue(false)
  await expect(createMainWorkflowArtifactTransferExtension(() => f.receiver).handle!(f.request, f.frame)).rejects.toThrow('No original source-package receiver')
})
