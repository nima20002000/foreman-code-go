import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { AgentConfigurationVersionSchema, HarnessExecutionSchema } from '@graphql/contracts'
import {
  AcceptedWorkflowRunV3Schema,
  ExecutableWorkflowV3Schema,
  RunStartV3InputSchema,
  SavedRunVersionSnapshotSchema,
  SavedWorkflowVersionDetailSchema,
  WorkflowVersionV3Schema,
  canonicalGraphJson,
} from '@graphql/contracts/wave25'

import { runStartSemantics } from '../src/modules/runs/repeatStartDispatch.js'
import {
  exitDecision,
  firstOccurrence,
  makeSimpleRepeatFixture,
  repeatExitOutput,
} from './helpers/eng04RepeatFixtures.js'

type NoRepeatShape = 'single' | 'sequential' | 'parallel' | 'conditional' | 'approval'

type RawScenario = {
  id: string
  shape: NoRepeatShape
  version: Record<string, unknown>
  configurations: Array<ReturnType<typeof AgentConfigurationVersionSchema.parse>>
  nodeIds: string[]
}

const at = '2026-09-25T14:00:00.000Z'
const digest = (value: unknown) => `sha256:${createHash('sha256').update(canonicalGraphJson(value)).digest('hex')}`
const edge = (id: string, source: string, target: string) => ({ id, kind: 'execution' as const, source, target })
const approvalEdge = (id: string, source: string, target: string) => ({ id, kind: 'approval' as const, source, target })

function configuration(workspaceId: string, scenario: string, name: string, role: 'coder' | 'orchestrator' = 'coder') {
  const agentId = `agent-${scenario}-${name}`
  return AgentConfigurationVersionSchema.parse({
    id: `config-${scenario}-${name}`,
    workspaceId,
    agentId,
    productRole: role,
    version: 1,
    harness: {
      harness: 'codex',
      model: 'synthetic-no-native-call',
      reasoningEffort: 'low',
      sandbox: 'read-only',
      serviceTier: 'standard',
    },
    prompt: {},
    assignedSkills: [],
    contentHash: `sha256:${'0'.repeat(64)}`,
    createdAt: at,
  })
}

function noRepeatScenario(id: string, shape: NoRepeatShape): RawScenario {
  const workspaceId = `ws-${id}`
  const workflowId = `wf-${id}`
  const names = shape === 'single' ? ['a']
    : shape === 'sequential' || shape === 'approval' ? ['a', 'b']
      : shape === 'parallel' ? ['a', 'b', 'c', 'e', 'd']
        : ['a', 'b', 'c', 'd']
  const configurations = names.map((name) => configuration(workspaceId, id, name,
    shape === 'approval' && name === 'a' ? 'orchestrator' : 'coder'))
  const nodes = configurations.map((item) => ({ id: `node-${id}-${item.agentId.split('-').at(-1)}`, agentId: item.agentId,
    name: `S3 ${item.agentId}` }))
  const node = (name: string) => nodes[names.indexOf(name)]!.id
  const edges = shape === 'single' ? []
    : shape === 'sequential' ? [edge(`${id}-a-b`, node('a'), node('b'))]
      : shape === 'parallel' ? [
        edge(`${id}-a-b`, node('a'), node('b')),
        edge(`${id}-a-c`, node('a'), node('c')),
        edge(`${id}-c-e`, node('c'), node('e')),
        edge(`${id}-b-d`, node('b'), node('d')),
        edge(`${id}-e-d`, node('e'), node('d')),
      ]
        : shape === 'conditional' ? [
          edge(`${id}-a-b`, node('a'), node('b')),
          edge(`${id}-a-c`, node('a'), node('c')),
          edge(`${id}-b-d`, node('b'), node('d')),
          edge(`${id}-c-d`, node('c'), node('d')),
        ]
          : [edge(`${id}-a-b`, node('a'), node('b')), approvalEdge(`${id}-approval-a-b`, node('a'), node('b'))]

  if (shape === 'conditional') {
    nodes[0] = {
      ...nodes[0]!,
      choice: { outcomes: [
        { outcome: 'left', target: { kind: 'edge' as const, relationshipId: `${id}-a-b` } },
        { outcome: 'right', target: { kind: 'edge' as const, relationshipId: `${id}-a-c` } },
      ] },
    } as typeof nodes[number]
  }

  const approval = shape === 'approval'
    ? { handler: 'orchestrator' as const, designatedOrchestratorAgentId: configurations[0]!.agentId }
    : { handler: 'user' as const }
  const definition = {
    id: workflowId,
    workspaceId,
    name: `S3 ${id}`,
    version: 1,
    executionSemanticsVersion: 3 as const,
    entryNodeId: nodes[0]!.id,
    executionCondition: { kind: 'manual' as const },
    approval,
    executionPolicy: { maxParallelism: shape === 'parallel' || shape === 'conditional' ? 3 : 1, maxNodeExecutions: nodes.length },
    nodes,
    edges,
    // Canonical S3-01..04 representation: repeat is ABSENT, never null/empty/cap-one.
  }
  const pins = Object.fromEntries(configurations.map((item) => [item.agentId, item.id]))
  const version = {
    id: `wv-${id}`,
    workspaceId,
    workflowId,
    version: 1,
    executionSemanticsVersion: 3 as const,
    entryNodeId: nodes[0]!.id,
    definition,
    approval,
    agentConfigurationVersionIds: pins,
    contentHash: digest({ definition, pins }),
    createdAt: at,
  }
  return { id, shape, version, configurations, nodeIds: nodes.map((item) => item.id) }
}

function location(id: string) {
  return { runnerId: `runner-${id}`, rootPath: `/synthetic/${id}`, locationRevision: 9,
    identityHash: digest({ device: id, inode: 9 }) }
}

function runCandidate(scenario: RawScenario, input: Record<string, unknown>) {
  const version = scenario.version as {
    id: string; workspaceId: string; workflowId: string; agentConfigurationVersionIds: Record<string, string>;
    approval: unknown; definition: { executionCondition: unknown }
  }
  return {
    id: `run-${scenario.id}`,
    workspaceId: version.workspaceId,
    workflowId: version.workflowId,
    workflowVersionId: version.id,
    executionSemanticsVersion: 3 as const,
    agentConfigurationVersionIds: version.agentConfigurationVersionIds,
    approval: version.approval,
    executionLocation: location(scenario.id),
    authorizationPrincipalId: `principal-${scenario.id}`,
    executionCondition: version.definition.executionCondition,
    executionState: 'queued' as const,
    outcome: 'pending' as const,
    input,
    createdAt: at,
  }
}

const noRepeatCases = [
  ['S3-01-single', 'single'],
  ['S3-01-sequential', 'sequential'],
  ['S3-02-parallel-unequal-join', 'parallel'],
  ['S3-03-conditional-join', 'conditional'],
  ['S3-04-approval', 'approval'],
] as const

describe('NIM-2648 ENG04-D reusable ENG-S3-ONLY architecture matrix', () => {
  it.each(noRepeatCases)('%s is a V3 workflow whose repeat field is absent across save/read/Start pins', (id, shape) => {
    const scenario = noRepeatScenario(id, shape)
    const rawDefinition = (scenario.version as { definition: Record<string, unknown> }).definition
    expect(Object.hasOwn(rawDefinition, 'repeat')).toBe(false)
    expect(rawDefinition.executionSemanticsVersion).toBe(3)

    // These are required positive assertions. At c6c9e61 they expose A's current
    // repeat-required V3 schema gap; do not change them to safeParse(false), skip,
    // an empty repeat plan or a V2 projection merely to make this lane green.
    const version = WorkflowVersionV3Schema.parse(scenario.version)
    expect(ExecutableWorkflowV3Schema.parse({ version, configurations: scenario.configurations }).version).toEqual(version)
    expect(SavedWorkflowVersionDetailSchema.parse({ version }).version).toEqual(version)

    const input = { scenario: id, exact: { requestId: `request-${id}` } }
    const request = RunStartV3InputSchema.parse({
      workspaceId: version.workspaceId,
      workflowId: version.workflowId,
      workflowVersionId: version.id,
      executionSemanticsVersion: 3,
      commandId: `command-${id}`,
      expectedWorkflowRevision: 7,
      expectedAgentConfigurationVersionIds: version.agentConfigurationVersionIds,
      expectedLocationRevision: 9,
      input,
    })
    expect(runStartSemantics(request)).toBe(3)
    const run = AcceptedWorkflowRunV3Schema.parse(runCandidate(scenario, input))
    expect(SavedRunVersionSnapshotSchema.parse({ run, version })).toEqual({ run, version })
    expect(run.workflowVersionId).toBe(version.id)
    expect(run.agentConfigurationVersionIds).toEqual(version.agentConfigurationVersionIds)
    expect(run.executionLocation).toEqual(location(id))
    expect(run.input).toEqual(input)

    const entry = version.definition.nodes.find((item) => item.id === version.entryNodeId)!
    const terminal = HarnessExecutionSchema.parse({
      id: `execution-${id}-1`,
      runId: run.id,
      workflowNodeId: entry.id,
      agentId: entry.agentId,
      agentConfigurationVersionId: version.agentConfigurationVersionIds[entry.agentId],
      attempt: 1,
      state: 'completed',
      input: { executionSemanticsVersion: 3, runInput: input, predecessors: [] },
      result: { outcome: 'succeeded', output: { scenario: id, rawResultId: `raw-result-${id}` } },
      createdAt: at,
      finishedAt: at,
    })
    expect(terminal.runId).toBe(run.id)
    expect(terminal.agentConfigurationVersionId).toBe(version.agentConfigurationVersionIds[terminal.agentId])
    expect(digest(terminal.input)).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(digest(terminal.result)).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  it('S3-02 persists a real unequal-depth all-required join shape without using repeat state', () => {
    const scenario = noRepeatScenario('S3-02-structure', 'parallel')
    const definition = (scenario.version as { definition: { edges: Array<{ source: string; target: string }>; repeat?: unknown } }).definition
    const entry = scenario.nodeIds[0]!, fast = scenario.nodeIds[1]!, deep1 = scenario.nodeIds[2]!, deep2 = scenario.nodeIds[3]!, join = scenario.nodeIds[4]!
    expect(definition.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: entry, target: fast }),
      expect.objectContaining({ source: entry, target: deep1 }),
      expect.objectContaining({ source: deep1, target: deep2 }),
      expect.objectContaining({ source: fast, target: join }),
      expect.objectContaining({ source: deep2, target: join }),
    ]))
    expect(Object.hasOwn(definition, 'repeat')).toBe(false)
  })

  it('S3-03 persists explicit selected/unselected conditional routes without a repeat wrapper', () => {
    const scenario = noRepeatScenario('S3-03-structure', 'conditional')
    const definition = (scenario.version as { definition: { nodes: Array<{ id: string; choice?: { outcomes: Array<{ outcome: string }> } }>; repeat?: unknown } }).definition
    expect(definition.nodes[0]!.choice?.outcomes.map((item) => item.outcome).sort()).toEqual(['left', 'right'])
    expect(Object.hasOwn(definition, 'repeat')).toBe(false)
  })

  it('S3-04 keeps approval assignment and reviewer edge inside the same no-repeat V3 family', () => {
    const scenario = noRepeatScenario('S3-04-structure', 'approval')
    const version = scenario.version as { approval: { handler: string; designatedOrchestratorAgentId?: string }; definition: { edges: Array<{ kind: string }>; repeat?: unknown } }
    expect(version.approval.handler).toBe('orchestrator')
    expect(version.approval.designatedOrchestratorAgentId).toBe(scenario.configurations[0]!.agentId)
    expect(version.definition.edges.some((item) => item.kind === 'approval')).toBe(true)
    expect(Object.hasOwn(version.definition, 'repeat')).toBe(false)
  })

  it('S3-05 preserves bounded-repeat early exit and exact finite limit exit', () => {
    const fixture = makeSimpleRepeatFixture(2, { suffix: 'eng04-d-s3-05' })
    expect(fixture.version.executionSemanticsVersion).toBe(3)
    expect(fixture.version.definition.repeat.blocks).toHaveLength(1)

    const first = firstOccurrence(fixture)
    const early = exitDecision(fixture, first.occurrence, 'pass', 's3-05-early-execution')
    expect(early.decision.reason).toBe('early_exit')
    expect(early.decision.resultData).toEqual(repeatExitOutput(1, 'pass').data)

    const firstAgain = exitDecision(fixture, first.occurrence, 'issues', 's3-05-repeat-execution')
    expect(firstAgain.decision.reason).toBe('repeat')
    const second = {
      ...first.occurrence,
      identity: { ...first.occurrence.identity, occurrenceId: 's3-05-occurrence-2', occurrenceIndex: 2 },
      input: { ...first.occurrence.input, bindingId: 's3-05-input-2', previous: {
        occurrenceId: first.occurrence.identity.occurrenceId,
        occurrenceIndex: 1,
        decisionId: firstAgain.decision.decisionId,
        acceptedResultDigest: firstAgain.decision.acceptedResultDigest,
      } },
    }
    const limit = exitDecision(fixture, second, 'issues', 's3-05-limit-execution')
    expect(limit.decision.reason).toBe('limit_exit')
    expect(limit.decision.target).toEqual(fixture.block.limitExit)
    expect(limit.decision.resultData).toEqual(repeatExitOutput(2, 'issues').data)
  })

  it('adding and removing repeat creates new saved V3 versions without changing execution semantics or configuration pins', () => {
    const fixture = makeSimpleRepeatFixture(2, { suffix: 'eng04-d-s3-toggle' })
    const withRepeat = structuredClone(fixture.version) as unknown as Record<string, unknown>
    const makeWithoutRepeat = (id: string, versionNumber: number) => {
      const value = structuredClone(fixture.version) as unknown as Record<string, unknown>
      value.id = id
      value.version = versionNumber
      const definition = value.definition as Record<string, unknown>
      definition.version = versionNumber
      delete definition.repeat
      value.contentHash = digest({ definition, pins: value.agentConfigurationVersionIds })
      return value
    }
    const before = makeWithoutRepeat('wv-eng04-d-s3-toggle-before', 1)
    withRepeat.id = 'wv-eng04-d-s3-toggle-repeat'
    withRepeat.version = 2
    ;(withRepeat.definition as Record<string, unknown>).version = 2
    withRepeat.contentHash = digest({ definition: withRepeat.definition, pins: withRepeat.agentConfigurationVersionIds })
    const after = makeWithoutRepeat('wv-eng04-d-s3-toggle-after', 3)

    expect([before, withRepeat, after].map((item) => item.executionSemanticsVersion)).toEqual([3, 3, 3])
    expect([before, withRepeat, after].map((item) => Object.hasOwn(item.definition as object, 'repeat'))).toEqual([false, true, false])
    expect(before.agentConfigurationVersionIds).toEqual(withRepeat.agentConfigurationVersionIds)
    expect(after.agentConfigurationVersionIds).toEqual(withRepeat.agentConfigurationVersionIds)
    expect(WorkflowVersionV3Schema.parse(before)).toEqual(before)
    expect(WorkflowVersionV3Schema.parse(withRepeat)).toEqual(withRepeat)
    expect(WorkflowVersionV3Schema.parse(after)).toEqual(after)
  })

  it('retired and unknown execution tags never select a second Start family', () => {
    expect(runStartSemantics({ executionSemanticsVersion: 3 })).toBe(3)
    for (const executionSemanticsVersion of [undefined, 1, 2, 0, 4, '3', null]) {
      expect(() => runStartSemantics({ executionSemanticsVersion })).toThrowError(
        expect.objectContaining({ code: 'EXECUTION_SEMANTICS_UNSUPPORTED' }),
      )
    }
  })

})
