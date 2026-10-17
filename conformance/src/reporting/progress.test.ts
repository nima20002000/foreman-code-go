import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runScenarios } from '../runner.js'
import type { TargetSession } from '../runtime/target.js'
import type { Scenario } from '../scenario.js'
import { CiProgress, type CiProgressEvent } from './progress.js'

const scenario: Scenario = {
  id: 'health.live', title: 'Liveness', lane: 'SKEL', run: async () => undefined,
}
type RecordedEvent = CiProgressEvent & { type: 'start' | 'finish' }

describe('CI progress and complete scenario results', () => {
  let directory: string
  let file: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'conformance-progress-'))
    file = join(directory, 'progress.jsonl')
    vi.stubEnv('CI_PROGRESS_FILE', file)
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(directory, { recursive: true, force: true })
  })

  async function events(): Promise<RecordedEvent[]> {
    const content = await readFile(file, 'utf8')
    return content.trim().split('\n').map(line => JSON.parse(line) as RecordedEvent)
  }

  function target(progress: CiProgress, cleanupFailure = false): TargetSession {
    return {
      target: 'go', baseUrl: 'http://127.0.0.1:49151', browserOrigin: 'http://127.0.0.1:49151',
      directory, environment: {}, applicationVersion: 'fixture-version',
      stop: async () => undefined, restart: async () => undefined,
      close: async () => {
        progress.cleanup(scenario, { type: 'start' })
        progress.cleanup(scenario, { type: 'finish', status: cleanupFailure ? 'failed' : 'passed' })
        if (cleanupFailure) throw new Error('Owned process failed to stop')
      },
    }
  }

  it('pairs watchdog events and finishes the current scenario only after successful cleanup', async () => {
    const progress = new CiProgress('go')
    progress.suite('start')
    const outcomes = await runScenarios([scenario], {
      launch: async () => target(progress), onProgress: event => progress.scenario(event),
    })
    progress.suite('finish', 'passed')
    const recorded = await events()
    expect(recorded.map(({ type, phase, kind }) => ({ type, phase, kind }))).toEqual([
      { type: 'start', phase: 'suite', kind: 'module' },
      { type: 'start', phase: 'setup', kind: 'module' },
      { type: 'finish', phase: 'setup', kind: 'module' },
      { type: 'start', phase: 'scenario', kind: 'test' },
      { type: 'start', phase: 'cleanup', kind: 'module' },
      { type: 'finish', phase: 'cleanup', kind: 'module' },
      { type: 'finish', phase: 'scenario', kind: 'test' },
      { type: 'finish', phase: 'suite', kind: 'module' },
    ])
    const active = new Set<string>()
    for (const event of recorded) {
      if (event.type === 'start') active.add(event.id)
      else expect(active.delete(event.id)).toBe(true)
      expect(event.id.startsWith(`${event.file}:go:`)).toBe(true)
      expect(event.target).toBe('go')
      if (event.phase !== 'suite') {
        expect(event.scenarioId).toBe('health.live')
        expect(event.lane).toBe('SKEL')
      }
    }
    expect(active.size).toBe(0)
    expect(recorded.find(event => event.phase === 'cleanup' && event.type === 'finish'))
      .toMatchObject({ cleanupCompleted: true, status: 'passed' })
    expect(outcomes[0]).toMatchObject({ status: 'passed', executed: true })
  })

  it('retains unimplemented setup failures without reporting an executed test', async () => {
    const progress = new CiProgress('go')
    const outcomes = await runScenarios([scenario], {
      launch: async () => { throw new Error('Go binary is unavailable') },
      onProgress: event => progress.scenario(event),
    })
    expect(outcomes[0]).toMatchObject({ status: 'failed', executed: false, phase: 'setup' })
    expect(await events()).toEqual([
      expect.objectContaining({ type: 'start', kind: 'module', phase: 'setup', executed: false }),
      expect.objectContaining({ type: 'finish', kind: 'module', phase: 'setup', executed: false, status: 'failed' }),
    ])
  })

  it('reports failed cleanup before the final failed scenario event', async () => {
    const progress = new CiProgress('go')
    const outcomes = await runScenarios([scenario], {
      launch: async () => target(progress, true), onProgress: event => progress.scenario(event),
    })
    const recorded = await events()
    expect(recorded.slice(-2)).toEqual([
      expect.objectContaining({ type: 'finish', phase: 'cleanup', cleanupCompleted: false, status: 'failed' }),
      expect.objectContaining({ type: 'finish', phase: 'scenario', executed: true, status: 'failed' }),
    ])
    expect(outcomes[0]).toMatchObject({ status: 'failed', phase: 'cleanup', executed: true,
      error: { message: 'Owned process failed to stop' } })
  })

  it('retains every raw outcome when the configured progress file cannot be written', async () => {
    vi.stubEnv('CI_PROGRESS_FILE', directory)
    const progress = new CiProgress('go')
    const second = { ...scenario, id: 'health.ready' }
    const outcomes = await runScenarios([scenario, second], {
      launch: async () => { throw new Error('Unimplemented target setup') },
      onProgress: event => progress.scenario(event),
    })
    expect(outcomes.map(({ id, status, executed }) => ({ id, status, executed }))).toEqual([
      { id: 'health.live', status: 'failed', executed: false },
      { id: 'health.ready', status: 'failed', executed: false },
    ])
    expect(progress.error?.message).toContain('EISDIR')
  })
})
