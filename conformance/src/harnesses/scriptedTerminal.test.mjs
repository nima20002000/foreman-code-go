import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import scriptedPlans from '../../fixtures/harnesses/scripted-plans.cjs'

const { presentThenHoldTerminal } = scriptedPlans
const directories = []

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'conformance-native-terminal-'))
  directories.push(root)
  await mkdir(join(root, 'control'), { mode: 0o700 })
  return { root, plan: { holdTerminalUntilFile: 'release-terminal' },
    operation: { cancelled: false, controller: new AbortController() } }
}

describe('scripted native terminal presentation boundary', () => {
  afterEach(async () => {
    vi.useRealTimers()
    await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
  })

  it('leaves ordinary plans unchanged without an opt-in provisional notification or terminal hold', async () => {
    const { root, operation } = await fixture()
    for (const plan of [undefined, { answer: 'Ordinary native result' }]) {
      const present = vi.fn()
      const terminal = vi.fn()
      await presentThenHoldTerminal(root, plan, operation, present).then(terminal)
      expect(present).not.toHaveBeenCalled()
      expect(terminal).toHaveBeenCalledOnce()
    }
  })

  it('presents once and retains terminal ownership until its real control file exists', async () => {
    const { root, plan, operation } = await fixture()
    const events = []
    const completion = presentThenHoldTerminal(root, plan, operation, () => events.push('native provisional'))
      .then(() => events.push('native terminal'))
    expect(events).toEqual(['native provisional'])
    await writeFile(join(root, 'control', plan.holdTerminalUntilFile), '', { flag: 'wx', mode: 0o600 })
    await completion
    expect(events).toEqual(['native provisional', 'native terminal'])
  })

  it('retains an exact bounded failure when terminal release is never supplied', async () => {
    const { root, plan, operation } = await fixture()
    vi.useFakeTimers()
    const present = vi.fn()
    const completion = presentThenHoldTerminal(root, plan, operation, present)
    const rejected = expect(completion).rejects.toThrow('Native terminal release timed out after 25000 ms: release-terminal')
    await vi.advanceTimersByTimeAsync(25_000)
    await rejected
    expect(present).toHaveBeenCalledOnce()
  })

  it('preserves cancellation during the terminal hold without completing the native turn', async () => {
    const { root, plan, operation } = await fixture()
    vi.useFakeTimers()
    const interruption = new Error('Owned native terminal hold was canceled')
    const terminal = vi.fn()
    const completion = presentThenHoldTerminal(root, plan, operation, () => undefined).then(terminal)
    const rejected = expect(completion).rejects.toBe(interruption)
    operation.controller.abort(interruption)
    await vi.advanceTimersByTimeAsync(20)
    await rejected
    expect(terminal).not.toHaveBeenCalled()
  })
})
