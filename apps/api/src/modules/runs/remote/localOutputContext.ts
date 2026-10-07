import { isDeepStrictEqual } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { DomainError } from '../../errors.js'
import type { NativeOutputCallCapture } from '../../harnesses/port.js'
import type { LocalWorkflowArtifactAuthority } from './localWorkflowArtifactAuthority.js'

type OutputContext = Awaited<ReturnType<LocalWorkflowArtifactAuthority['context']>>

/** Join an approval observer's writer handoff without replaying the native call. */
export async function admitNativeOutputContext(input: {
  signal: AbortSignal
  capture(): Promise<NativeOutputCallCapture>
  context(): Promise<OutputContext>
  checkDeclaration(): Promise<unknown>
}) {
  let native = await input.capture()
  const original = structuredClone(native.descriptor)
  for (;;) {
    input.signal.throwIfAborted()
    try {
      native.assertCurrent()
      const accepted = await input.context()
      native.assertCurrent()
      input.signal.throwIfAborted()
      return { native, accepted }
    } catch (error) {
      input.signal.throwIfAborted()
      let lost: unknown
      try { native.assertCurrent() }
      catch (currentError) { lost = currentError }
      if (lost instanceof DomainError && lost.code === 'SESSION_LANE_LEASE_LOST') {
        await input.checkDeclaration()
        input.signal.throwIfAborted()
        native = await input.capture()
        if (!isDeepStrictEqual(native.descriptor, original)) {
          throw new DomainError('WORKFLOW_NATIVE_OUTPUT_CALL_CONFLICT',
            'The native output callback changed during writer recovery.', 409)
        }
        continue
      }
      if (lost !== undefined) throw lost
      if (!(error instanceof DomainError) || error.code !== 'NATIVE_ARTIFACT_CONTEXT_PENDING') throw error
      await input.checkDeclaration()
      await delay(25, undefined, { signal: input.signal })
    }
  }
}
