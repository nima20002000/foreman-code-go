import type { ScenarioProgress } from '../runner.js'
import type { TargetCleanupEvent } from '../runtime/target.js'
import type { Scenario } from '../scenario.js'
import { describeFailure } from './report.js'
import { writeCiProgressEvent } from './progress-writer.mjs'
import type { Lane, ScenarioFailure, Target } from './types.js'

export interface CiProgressEvent {
  id: string
  file: string
  name: string
  kind: 'module' | 'test'
  target: Target
  phase: 'suite' | 'setup' | 'scenario' | 'coverage' | 'cleanup'
  scenarioId?: string
  lane?: Lane
  status?: 'passed' | 'failed'
  executed?: boolean
  cleanupCompleted?: boolean
}

type ScenarioIdentity = Pick<Scenario, 'id' | 'title' | 'lane'>

/** Progress supplements the complete result JSON; an I/O error cannot discard scenario outcomes. */
export class CiProgress {
  private writeFailure: ScenarioFailure | undefined

  constructor(private readonly target: Target) {}

  get error(): ScenarioFailure | undefined { return this.writeFailure }

  private record(type: 'start' | 'finish', event: Omit<CiProgressEvent, 'target'>): void {
    if (this.writeFailure) return
    try { writeCiProgressEvent(type, { ...event, target: this.target }) }
    catch (error) {
      this.writeFailure = describeFailure(error)
    }
  }

  suite(type: 'start' | 'finish', status?: 'passed' | 'failed'): void {
    this.record(type, {
      id: `${this.target}:suite`, file: 'conformance/src/main.ts', name: `${this.target} conformance`,
      kind: 'module', phase: 'suite', ...(status === undefined ? {} : { status }),
    })
  }

  scenario(event: ScenarioProgress): void {
    this.record(event.type, {
      id: `${this.target}:${event.scenario.id}:${event.phase}`,
      file: event.phase === 'setup' ? 'conformance/src/runtime/target.ts' : 'conformance/src/main.ts',
      name: `[${event.scenario.lane}] ${event.scenario.id}: ${event.scenario.title}`,
      kind: event.phase === 'scenario' ? 'test' : 'module', phase: event.phase,
      scenarioId: event.scenario.id, lane: event.scenario.lane, executed: event.executed,
      ...(event.status === undefined ? {} : { status: event.status }),
    })
  }

  cleanup(scenario: ScenarioIdentity | undefined, event: TargetCleanupEvent): void {
    const id = scenario?.id ?? 'coverage.mcp'
    this.record(event.type, {
      id: `${this.target}:${id}:cleanup`, file: 'conformance/src/runtime/target.ts',
      name: scenario ? `[${scenario.lane}] ${id}: cleanup` : 'Live MCP coverage: cleanup',
      kind: 'module', phase: 'cleanup',
      ...(scenario ? { scenarioId: scenario.id, lane: scenario.lane } : {}),
      ...(event.type === 'finish' ? { status: event.status, cleanupCompleted: event.status === 'passed' } : {}),
    })
  }

  coverage(type: 'start' | 'finish', status?: 'passed' | 'failed'): void {
    this.record(type, {
      id: `${this.target}:coverage.mcp`, file: 'conformance/src/coverage/live.ts',
      name: 'Live Operator MCP tools/list coverage', kind: 'module', phase: 'coverage',
      ...(status === undefined ? {} : { status }),
    })
  }
}
