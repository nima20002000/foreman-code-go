import assert from 'node:assert/strict'
import {
  RepeatOccurrenceV1Schema, RunAcceptedInputValueSchema, RunExecutionsPageSchema,
  type RepeatOccurrenceIdentityV1, type RunExecutionBinding, type RunExecutionSummary,
} from '@foreman-code/contracts/wave25'
import { assertJson, assertResponse } from '../../assertions.js'
import type { Scenario, ScenarioContext } from '../../scenario.js'
import { independentCodexSessions } from './agents.js'
import { createExecutableWorkflow } from './authoring.js'
import { installCodexScripts } from './codexScript.js'
import { workflowDigest } from './digest.js'
import {
  assertBindings, assertExecutionDetail, assertExecutions, executionIdentity,
  predecessor, readExecutionDetail, runScope, runSummary,
} from './inspection.js'
import { runPath, startWorkflow, waitForCompletedRun } from './runs.js'

function exitResult(outcome: 'issues' | 'pass', revision: number) {
  return { outcome: 'succeeded' as const, output: { text: JSON.stringify({
    routing: { outcome }, data: { latestDeliverable: { revision },
      remainingFindings: outcome === 'issues' ? ['One correction remains.'] : [] },
  }) } }
}

function producerResult(revision: number) {
  return { outcome: 'succeeded' as const, output: { text: `Conformance deliverable ${revision}` } }
}

function findExecution(items: readonly RunExecutionSummary[], nodeId: string, occurrenceIndex: number) {
  const matches = items.filter(item => item.workflowNodeId === nodeId && item.occurrence?.occurrenceIndex === occurrenceIndex)
  assert.equal(matches.length, 1, 'Each selected node runs once in each repeat occurrence')
  return matches[0]!
}

async function runRepeat(ctx: ScenarioContext, outcomes: readonly ('issues' | 'pass')[]) {
  const prompts = ['Conformance repeat produce', 'Conformance repeat decide']
  const fixture = await createExecutableWorkflow(ctx, { name: 'Repeat accepted deliverables', form: 'repeat',
    configuration: independentCodexSessions(),
    configureGraph: definition => ({ ...definition,
      nodes: definition.nodes.map((node, index) => ({ ...node, initialPrompt: prompts[index]! })),
    }),
  })
  const produced = outcomes.map((_, index) => producerResult(index + 1))
  const decisions = outcomes.map((outcome, index) => exitResult(outcome, index + 1))
  await installCodexScripts(ctx, [
    { id: 'repeat-producer', includes: prompts[0]!, turns: produced.map(result => ({ answer: result.output.text })) },
    { id: 'repeat-decider', includes: prompts[1]!, turns: decisions.map(result => ({ answer: result.output.text })) },
  ])
  const { run } = await startWorkflow(ctx, fixture, { task: 'Keep these accepted inputs', settings: { revision: 7 } })
  const completed = await waitForCompletedRun(ctx, run, decisions.at(-1)!)
  const response = await ctx.http.request('GET', `${runPath(run)}/executions?limit=100`)
  assert.equal(response.status, 200)
  const discovered = RunExecutionsPageSchema.parse(response.body)
  assert.equal(discovered.items.length, outcomes.length * 2)
  const [producer, decider] = fixture.saved.version.definition.nodes
  assert.ok(producer && decider)
  const relationship = fixture.saved.version.definition.edges.find(edge => edge.kind === 'execution')
  assert.ok(relationship)
  const identities: RepeatOccurrenceIdentityV1[] = []
  for (let index = 1; index <= outcomes.length; index++) {
    const occurrence = findExecution(discovered.items, producer.id, index).occurrence
    assert.ok(occurrence)
    assertJson(occurrence, { scope: runScope(run), blockId: 'repair', occurrenceId: '<id>', occurrenceIndex: index },
      [{ pointer: '/body/occurrenceId', kind: 'id' }])
    identities.push(occurrence)
  }
  assert.equal(new Set(identities.map(identity => identity.occurrenceId)).size, identities.length)
  const items = await assertExecutions(ctx, fixture, completed, identities.flatMap(occurrence => [
    { nodeId: producer.id, occurrence }, { nodeId: decider.id, occurrence },
  ]))
  for (let index = 0; index < outcomes.length; index++) {
    const producing = findExecution(items, producer.id, index + 1)
    const deciding = findExecution(items, decider.id, index + 1)
    const detail = await readExecutionDetail(ctx, run, producing.executionId)
    assert.ok('occurrence' in detail.value.acceptedInput.value)
    const occurrence = RepeatOccurrenceV1Schema.parse(detail.value.acceptedInput.value.occurrence)
    let carry: Extract<RunExecutionBinding, { kind: 'carry' }>['source'] | null = null
    if (index > 0) {
      assert.ok(occurrence.input.previous)
      const previous = findExecution(items, decider.id, index)
      carry = { decisionId: occurrence.input.previous.decisionId,
        execution: { ...executionIdentity(previous), occurrence: identities[index - 1]! },
        acceptedResultDigest: workflowDigest(decisions[index - 1]!), acceptedResult: decisions[index - 1]!,
      }
    }
    const entry = { runInput: run.input, external: [], carry }
    const previous = carry === null ? null : { occurrenceId: identities[index - 1]!.occurrenceId,
      occurrenceIndex: index, decisionId: '<id>', acceptedResultDigest: workflowDigest(decisions[index - 1]!),
    }
    assertJson(occurrence, { contractVersion: 1, identity: identities[index],
      input: { bindingId: '<id>', inputDigest: workflowDigest(entry), previous },
    }, [{ pointer: '/body/input/bindingId', kind: 'id' },
      ...(carry === null ? [] : [{ pointer: '/body/input/previous/decisionId', kind: 'id' as const }]),
    ])
    const producerInput = RunAcceptedInputValueSchema.parse({ executionSemanticsVersion: 3,
      runInput: run.input, occurrence, entry, predecessors: [],
    })
    await assertExecutionDetail(ctx, completed, producing, producerInput, produced[index]!)
    await assertBindings(ctx, run, producing, producerInput, carry === null ? [] : [{ kind: 'carry', source: carry }])
    const source = predecessor(relationship.id, producing, produced[index]!)
    const deciderInput = RunAcceptedInputValueSchema.parse({ executionSemanticsVersion: 3,
      runInput: run.input, occurrence, entry: null, predecessors: [source],
    })
    await assertExecutionDetail(ctx, completed, deciding, deciderInput, decisions[index]!)
    await assertBindings(ctx, run, deciding, deciderInput, [{ kind: 'predecessor', source }])
  }
  assertResponse(await ctx.http.request('GET', `${runPath(run)}/version`), {
    status: 200, body: { scope: runScope(run), version: fixture.saved.version },
  })
  await ctx.target.restart()
  assertResponse(await ctx.http.request('GET', `${runPath(run)}/record`), { status: 200, body: completed })
  assertResponse(await ctx.http.request('GET', `${runPath(run)}/executions?limit=100`), {
    status: 200, body: { run: runSummary(completed), items, pageInfo: { nextCursor: null } },
  })
}

export const repeatWorkflowScenarios: Scenario[] = [
  {
    id: 'workflow.repeat-early-exit',
    title: 'Repeat carries the accepted first decision and exits on the next passing deliverable',
    lane: 'E', timeoutMs: 180_000,
    covers: [{ surface: 'workflow', name: 'repeat', case: 'success' }],
    async run(ctx) { await runRepeat(ctx, ['issues', 'pass']) },
  },
  {
    id: 'workflow.repeat-limit-exit',
    title: 'Repeat preserves all three occurrences and stops at the configured limit exit',
    lane: 'E', timeoutMs: 180_000,
    covers: [{ surface: 'workflow', name: 'repeat', case: 'success' }],
    async run(ctx) { await runRepeat(ctx, ['issues', 'issues', 'issues']) },
  },
]
