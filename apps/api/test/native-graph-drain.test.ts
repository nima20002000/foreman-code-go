import assert from 'node:assert/strict'
import { it, vi } from 'vitest'
import { cleanupTimeoutMs } from '../src/modules/interactions/cleanup.js'
import { DomainError } from '../src/modules/errors.js'
import { executeRepeatRuntime, type RepeatRuntimeLifecycle } from '../src/modules/runs/repeatRuntime.js'
import { a1Scenario, graphHarness } from './helpers/eng04A1GraphHarness.js'

// Real LangGraph/checkpointer; native and persistence are deterministic unit ports.
it('keeps a healthy sibling observing beyond the cleanup deadline during a pending native boundary', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const f = a1Scenario('parallel')
    let reached!: () => void, pending = true
    const siblingStarted = new Promise<void>((resolve) => { reached = resolve })
    const h = graphHarness(f, { beforeObserve: async (execution, _ref, signal) => {
      if (execution.workflowNodeId === f.version.definition.nodes[2]!.id) {
        reached()
        await new Promise<void>((resolve, reject) => {
          const aborted = () => {
            clearTimeout(timer)
            reject(signal.reason)
          }
          const timer = setTimeout(() => {
            signal.removeEventListener('abort', aborted)
            resolve()
          }, cleanupTimeoutMs + 1500)
          signal.addEventListener('abort', aborted, { once: true })
          if (signal.aborted) aborted()
        })
      } else if (execution.workflowNodeId === f.version.definition.nodes[1]!.id && pending) {
        await siblingStarted
        pending = false
        throw new DomainError('REPEAT_BOUNDARY_PENDING', 'The original native boundary is still pending.', 409)
      }
    } })
    const lifecycle: RepeatRuntimeLifecycle = {
      preflight: async () => {}, markRunning: async () => {},
      currentState: async () => ({ executionState: 'running', stopRequested: false }),
      persistWait: async () => false,
      cancelNativeAndRequestCleanup: async () => { throw new Error('Healthy sibling was canceled.') },
      settleRun: async () => { throw new Error('Pending observation was negatively settled.') },
      requestCleanup: async () => {}, finishNative: async () => {}, finishCleanup: async () => {},
    }
    const running = executeRepeatRuntime({ ...h.input, owner: { assertOwned() {} }, lifecycle })
    const settled = Promise.allSettled([running])
    await siblingStarted
    await vi.advanceTimersByTimeAsync(cleanupTimeoutMs + 1500)
    await settled
    await running
    assert.equal(h.completeCalls, 1)
    assert.equal(h.candidateIds.length, f.version.definition.nodes.length)
    const sibling = [...h.executions.values()].find((execution) => execution.workflowNodeId === f.version.definition.nodes[2]!.id)!
    assert.equal(h.observations.filter((id) => id === sibling.id).length, 1)
  } finally {
    vi.useRealTimers()
  }
}, 15_000)
