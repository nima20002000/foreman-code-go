import { describe, expect, it, vi } from 'vitest'
import { makeWave25Fixture, type NodeResolution } from '@graphql/contracts/wave25'
import { ExecutionLimiter } from '../src/modules/runs/limiter.js'
import { oneShotNodeAction } from '../src/modules/runs/oneShotNode.js'
import { inactiveOneShotResolution, oneShotResolution } from '../src/modules/runs/oneShotResolution.js'
import type { OneShotRunRepository } from '../src/modules/runs/oneShotPostgres.js'
import { HarnessExecutionSchema } from '@graphql/contracts'

function setup(resolutionKind: 'skipped' | 'succeeded' = 'skipped') {
  const f = makeWave25Fixture('a3-node')
  const nodeId = f.executions[0]!.workflowNodeId
  const success = HarnessExecutionSchema.parse({ ...f.executions[0], state: 'completed', finishedAt: f.createdAt, result: { outcome: 'succeeded', output: 'done' } })
  const resolution = resolutionKind === 'skipped' ? inactiveOneShotResolution(f.version, nodeId, 'skipped', f.createdAt) : oneShotResolution(f.version, success)
  const store = {
    admit: vi.fn<OneShotRunRepository['admit']>().mockResolvedValue({ kind: 'resolved', resolution }),
    acceptTerminal: vi.fn<OneShotRunRepository['acceptTerminal']>().mockResolvedValue(resolution),
  }
  const driver = { candidate: vi.fn(() => f.executions[0]!), observe: vi.fn(async () => undefined) }
  const controller = new AbortController()
  return { f, nodeId, success, resolution, store, driver, controller, state: { runId: f.run.id, executionIds: {} } }
}

describe('Agent 3 lazy one-shot wrappers and bounded native capacity', () => {
  it('skips with no candidate, capacity wait, native resource or fabricated execution identity', async () => {
    const s = setup()
    const limiter = new ExecutionLimiter(1)
    const capacity = vi.spyOn(limiter, 'run')
    const action = oneShotNodeAction({ runId: s.f.run.id, store: s.store, driver: s.driver, limiter, signal: s.controller.signal })
    expect(await action(s.nodeId, s.state)).toEqual({})
    expect(s.driver.candidate).not.toHaveBeenCalled()
    expect(s.driver.observe).not.toHaveBeenCalled()
    expect(capacity).not.toHaveBeenCalled()
  })
  it('repairs a terminal result after checkpoint failure without relaunching accepted work', async () => {
    const s = setup('succeeded')
    s.store.admit.mockResolvedValue({ kind: 'admitted', execution: s.success, reused: true })
    const action = oneShotNodeAction({ runId: s.f.run.id, store: s.store, driver: s.driver, limiter: new ExecutionLimiter(1), signal: s.controller.signal })
    expect(await action(s.nodeId, s.state)).toEqual({ executionIds: { [s.nodeId]: s.success.id } })
    expect(s.driver.observe).not.toHaveBeenCalled()
    expect(s.store.acceptTerminal).toHaveBeenCalledWith(s.success.id)
  })
  it('does not use a resolved checkpoint to activate the same execution again', async () => {
    const s = setup('succeeded')
    const action = oneShotNodeAction({ runId: s.f.run.id, store: s.store, driver: s.driver, limiter: new ExecutionLimiter(1), signal: s.controller.signal })
    await action(s.nodeId, s.state)
    await action(s.nodeId, s.state)
    expect(s.driver.observe).not.toHaveBeenCalled()
    expect(s.store.acceptTerminal).not.toHaveBeenCalled()
  })
  it('rejects a different Run and unresolved joins without any native call', async () => {
    const s = setup()
    const action = oneShotNodeAction({ runId: s.f.run.id, store: s.store, driver: s.driver, limiter: new ExecutionLimiter(1), signal: s.controller.signal })
    await expect(action(s.nodeId, { runId: 'other', executionIds: {} })).rejects.toThrow()
    s.store.admit.mockResolvedValue({ kind: 'waiting' })
    await expect(action(s.nodeId, s.state)).rejects.toThrow()
    expect(s.driver.observe).not.toHaveBeenCalled()
  })
  it('commits queue admission before capacity wait; queued Stop never enters observe', async () => {
    const s = setup()
    const limiter = new ExecutionLimiter(1)
    let release!: () => void
    const blocker = limiter.run(new AbortController().signal, () => new Promise<void>((resolve) => { release = resolve }))
    s.store.admit.mockResolvedValue({ kind: 'admitted', execution: s.f.executions[0]!, reused: false })
    const action = oneShotNodeAction({ runId: s.f.run.id, store: s.store, driver: s.driver, limiter, signal: s.controller.signal })
    const waiting = action(s.nodeId, s.state)
    await Promise.resolve(); await Promise.resolve()
    expect(s.store.admit).toHaveBeenCalledOnce()
    expect(s.driver.observe).not.toHaveBeenCalled()
    const rejected = expect(waiting).rejects.toThrow('stop')
    s.controller.abort(new Error('stop'))
    release()
    await blocker
    await rejected
    expect(s.driver.observe).not.toHaveBeenCalled()
  })
  it('retains FIFO capacity when an intervening waiter cancels', async () => {
    const limiter = new ExecutionLimiter(1, 3)
    const signal = new AbortController().signal
    let release!: () => void
    const order: number[] = []
    const first = limiter.run(signal, () => new Promise<void>((resolve) => { release = resolve }))
    const a = limiter.run(signal, async () => { order.push(1) })
    const canceled = new AbortController()
    const b = limiter.run(canceled.signal, async () => { order.push(2) })
    const rejected = expect(b).rejects.toThrow('stop')
    const c = limiter.run(signal, async () => { order.push(3) })
    canceled.abort(new Error('stop'))
    release()
    await Promise.all([first, a, c, rejected])
    expect(order).toEqual([1, 3])
  })
  it('bounds admission and does not leak a slot when a transferred waiter stops', async () => {
    const limiter = new ExecutionLimiter(1, 1)
    const normal = new AbortController().signal
    let release!: () => void
    const first = limiter.run(normal, () => new Promise<void>((resolve) => { release = resolve }))
    const controller = new AbortController()
    const next = limiter.run(controller.signal, async () => undefined)
    await expect(limiter.run(normal, async () => undefined)).rejects.toThrow('RUNNER_ADMISSION_FULL')
    const rejected = expect(next).rejects.toThrow('stop')
    release()
    controller.abort(new Error('stop'))
    await Promise.all([first, rejected])
    await expect(limiter.run(normal, async () => 'available')).resolves.toBe('available')
  })
  it.each(['pass', 'issues'])('performs %s routing with zero/one Fixer observations', async (outcome) => {
    const f = makeWave25Fixture(`a3-${outcome}`)
    const root = f.version.definition.nodes[0]!, fixer = f.version.definition.nodes[1]!
    root.choice = { outcomes: [{ outcome: 'pass', target: { kind: 'branch_end' } },
      { outcome: 'issues', target: { kind: 'edge', relationshipId: f.version.definition.edges[0]!.id } }] }
    const completed = HarnessExecutionSchema.parse({ ...f.executions[0], state: 'completed', finishedAt: f.createdAt,
      result: { outcome: 'succeeded', output: { routing: { outcome }, data: {} } } })
    const rootResolution = oneShotResolution(f.version, completed)
    const fixerResolution: NodeResolution = outcome === 'pass'
      ? inactiveOneShotResolution(f.version, fixer.id, 'skipped', f.createdAt)
      : oneShotResolution(f.version, HarnessExecutionSchema.parse({ ...f.executions[1], state: 'completed', finishedAt: f.createdAt, result: { outcome: 'succeeded', output: 'fixed' } }))
    expect(rootResolution.selectedRelationshipIds.length).toBe(outcome === 'pass' ? 0 : 1)
    const observe = vi.fn(async () => undefined)
    const action = oneShotNodeAction({ runId: f.run.id, signal: new AbortController().signal, limiter: new ExecutionLimiter(1),
      driver: { candidate: () => f.executions[1]!, observe }, store: {
        admit: async () => outcome === 'pass' ? { kind: 'resolved', resolution: fixerResolution }
          : { kind: 'admitted', execution: f.executions[1]!, reused: false },
        acceptTerminal: async () => fixerResolution,
      } })
    await action(fixer.id, { runId: f.run.id, executionIds: { [root.id]: completed.id } })
    expect(observe).toHaveBeenCalledTimes(outcome === 'pass' ? 0 : 1)
  })
})
