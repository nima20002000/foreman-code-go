import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { NativeSessionReference } from '@foreman-code/contracts'
import { input } from '../fixtures/codex-test-helpers.js'
import { faultWorkflowWorker } from './faultWorkflowWorker.js'

it.each(['session', 'turn'] as const)('runs a scoped workflow with correlation supplied at %s creation', async binding => {
  const scratch = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(scratch, { recursive: true })
  const directory = await mkdtemp(join(scratch, 'workflow-replay-'))
  const worker = await faultWorkflowWorker(directory)
  const manager = worker.manager()
  const controller = new AbortController()
  let settled: Promise<unknown> | undefined
  try {
    const source = input(directory)
    const correlationId = `execution:${source.request.executionId}`
    let session: NativeSessionReference | undefined
    const events: string[] = []
    const stream = (async () => {
      session = await manager.createSession({ ...source, ...(binding === 'session' ? { correlationId } : {}) })
      for await (const event of manager.startTurn(session, {
        clientCorrelationId: correlationId, prompt: 'Complete the task.',
      }, controller.signal)) events.push(event.type)
    })()
    settled = Promise.allSettled([stream])
    await Promise.race([vi.waitFor(() => expect(worker.replay.starts).toHaveLength(1)), stream])
    const turn = worker.replay.starts[0]!
    worker.replay.complete(turn.sessionId, turn.nativeTurnId, 'complete')
    await stream
    expect(events).toContain('turn.completed')
    expect(session).toBeDefined()
    expect((await manager.history(session!)).terminalResult).toMatchObject({ outcome: 'succeeded' })
  } finally {
    controller.abort()
    await settled
    await worker.close()
    await rm(directory, { recursive: true, force: true })
  }
})
