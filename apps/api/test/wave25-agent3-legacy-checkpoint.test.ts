import { Command, MemorySaver, interrupt } from '@langchain/langgraph'
import { WorkflowRunSchema, WorkflowVersionSchema, type WorkflowVersion, type WorkflowRun } from '@graphql/contracts'
import { makeWave25Fixture } from '@graphql/contracts/wave25'
import { expect, it, vi } from 'vitest'
import { LangGraphWorkflowEngine } from '../src/modules/runs/engine.js'
import type { OneShotCheckpoint } from '../src/modules/runs/oneShotGraph.js'

type State = { runId: string; executionIds: Record<string, string> }
type Internals = {
  buildGraph(version: WorkflowVersion, action: (id: string, state: State) => Promise<Partial<State>>): {
    invoke(input: State | Command, config: { configurable: { thread_id: string } }): Promise<State>
    getState(config: { configurable: { thread_id: string } }): Promise<OneShotCheckpoint>
  }
  readCheckpoint(run: WorkflowRun): Promise<{ version: WorkflowVersion; snapshot: OneShotCheckpoint }>
}

it('reads and resumes an existing legacy approval-wait checkpoint without selecting the v2 engine or replaying the predecessor', async () => {
  const f = makeWave25Fixture('a3-legacy-wait')
  const rawVersion = JSON.parse(JSON.stringify(f.version)) as Record<string, unknown>
  delete rawVersion.executionSemanticsVersion
  const graph = rawVersion.definition as Record<string, unknown>
  delete graph.executionSemanticsVersion; delete graph.entryNodeId
  graph.edges = f.version.definition.edges.map(({ kind, ...edge }) => { void kind; return { ...edge, route: { outcomes: ['succeeded'] } } })
  const version = WorkflowVersionSchema.parse(rawVersion)
  const rawRun = JSON.parse(JSON.stringify(f.run)) as Record<string, unknown>
  delete rawRun.executionSemanticsVersion
  const run = WorkflowRunSchema.parse(rawRun)
  const saver = new MemorySaver()
  type Args = ConstructorParameters<typeof LangGraphWorkflowEngine>
  const getOneShotVersion = vi.fn(async () => { throw new Error('Must not reinterpret a legacy checkpoint as v2') })
  const workflows = { getVersion: vi.fn(async () => version) }
  const engine = new LangGraphWorkflowEngine({ getOneShotVersion } as unknown as Args[0], workflows as unknown as Args[1],
    {} as Args[2], saver, '/tmp/synthetic-no-allocation', {} as Args[5]) as unknown as Internals
  const calls: string[] = []
  const action = async (id: string) => {
    calls.push(id)
    if (id !== version.entryNodeId) {
      const resume: unknown = interrupt({ interactionId: 'legacy-interaction', interactionIds: ['legacy-interaction'] })
      expect(resume).toEqual({ interactionId: 'legacy-interaction' })
    }
    return { executionIds: { [id]: `legacy-execution-${id}` } }
  }
  const config = { configurable: { thread_id: run.id } }
  await engine.buildGraph(version, action).invoke({ runId: run.id, executionIds: {} }, config)
  const before = await engine.readCheckpoint(run)
  expect(before.version).toEqual(version); expect(getOneShotVersion).not.toHaveBeenCalled()
  expect(before.snapshot.tasks[0]!.interrupts![0]!.value).toEqual({ interactionId: 'legacy-interaction', interactionIds: ['legacy-interaction'] })
  const interruptId = before.snapshot.tasks[0]!.interrupts![0]!.id
  await engine.buildGraph(version, action).invoke(new Command({ resume: { [interruptId]: { interactionId: 'legacy-interaction' } } }), config)
  expect(calls.filter((id) => id === version.entryNodeId)).toHaveLength(1)
  expect((await engine.readCheckpoint(run)).snapshot.tasks).toEqual([])
})
