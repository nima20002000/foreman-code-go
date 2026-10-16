import { join } from 'node:path'
import { expect, it } from 'vitest'
import { RemoteOperationReceiptSchema } from '@foreman-code/contracts/remote-execution'
import { remoteWorkflowPhysicalOutput } from '@foreman-code/contracts/remote-workflow-physical'
import { remoteWorkflowSourceDigest } from './workflowPhysicalReadout.js'
import { InstalledWorkflowRecovery } from './installedWorkflowRecovery.js'
import { NativeProcessRegistry } from '../../harnesses/recovery/processRegistry.js'
import { restartedInstalledFixture, runningInstalledFixture } from './__tests__/installedWorkflowHost.js'

it.each([false, true])('keeps recovered session ACKs readable until terminal history retirement (retire=%s)', async retire => {
  const f = await restartedInstalledFixture()
  await f.journal.close()
  const host = await f.startHost()
  const call = (method: string, fields: Record<string, unknown> = {}) => host.extensions[0]!.handle!({
    method, intent: f.intent, placement: f.placement, ...fields,
  }, f.context)
  try {
    const reply = await call('reattach', { session: f.session, request: f.request })
    const receipt = RemoteOperationReceiptSchema.parse((reply.payload as { status: { receipt: unknown } }).status.receipt)
    const selector = { receiptSequence: receipt.sequence,
      sourceDigest: remoteWorkflowSourceDigest({ type: 'session_created', session: f.session }) }
    expect((await call('physical-ack', { ...selector, retire })).payload).toMatchObject({ status: 'retired' })
    const history = await call('history')
    expect(history.payload).toMatchObject({ status: { receipt } })
    const source = { type: 'history' as const, history: (history.payload as { history: never }).history }
    expect((await call('physical-ack', { receiptSequence: receipt.sequence,
      sourceDigest: remoteWorkflowSourceDigest(source), retire: true })).payload).toMatchObject({ status: 'retired' })
    await expect(call('history')).rejects.toThrow()
    expect((await call('status')).payload).toMatchObject({ receipt })
  } finally { await host.close() }
})

it.each([undefined, ['report']] as const)('persists complete physical output before exposing terminal settlement (%s)', async artifactOutputKeys => {
  const f = await runningInstalledFixture('generation', artifactOutputKeys ? { artifactOutputKeys: [...artifactOutputKeys] } : {})
  const recovery = new InstalledWorkflowRecovery(join(f.root, 'workflow-recovery'),
    new NativeProcessRegistry(join(f.root, 'native-processes')))
  const result = { outcome: 'succeeded' as const, output: { text: 'provider answer' } }
  try {
    f.finish('succeeded', result.output)
    await f.settled
    const status = await f.journal.status(f.intent.operationId)
    if (status.status !== 'known' || !status.receipt.terminal) throw new Error('Expected terminal result')
    const declaration = f.placement.payload.kind === 'agent' ? f.placement.payload.artifactOutputs : undefined
    expect(await recovery.readOutput(f.intent.operationId)).toEqual(remoteWorkflowPhysicalOutput(
      result, declaration, status.receipt.terminal.artifactValidationError,
    ))
  } finally {
    f.finish('canceled')
    await f.host.close()
  }
})

it('refuses to invent artifact output when a recovered terminal has no saved output', async () => {
  const f = await restartedInstalledFixture()
  const result = { outcome: 'succeeded' as const, output: { text: 'artifact result' } }
  await f.journal.terminal(f.intent.operationId, { kind: 'completed', result,
    artifactDigests: ['a'.repeat(64)], resultDigest: 'b'.repeat(64), closureEvidenceDigest: 'c'.repeat(64) })
  await f.journal.close()
  const host = await f.startHost()
  try {
    await expect(host.extensions[0]!.handle!({ method: 'history', intent: f.intent,
      placement: f.placement }, f.context)).rejects.toThrow('Original workflow recovery output is missing')
  } finally { await host.close() }
})
