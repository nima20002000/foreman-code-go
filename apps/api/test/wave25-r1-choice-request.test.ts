import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HarnessExecutionSchema, type HarnessExecutionRequest } from '@graphql/contracts'
import { makeWave25Fixture, parseChoiceResultEnvelope, type WorkflowChoice } from '@graphql/contracts/wave25'
import { buildHarnessPrompt } from '../src/modules/harnesses/prompt.js'
import { oneShotInitialPrompt } from '../src/modules/runs/oneShotPrompt.js'
import { oneShotExecutionDriver, type OneShotRuntimeContext } from '../src/modules/runs/oneShotRuntime.js'

const directories: string[] = []
afterEach(async () => { while (directories.length) await rm(directories.pop()!, { recursive: true, force: true }) })
const choice = (first = 'pass', second = 'issues'): WorkflowChoice => ({ outcomes: [
  { outcome: first, target: { kind: 'branch_end' } },
  { outcome: second, target: { kind: 'edge', relationshipId: 'private-edge' } },
] })

/** Exercises the real driver/request builder. Only the coordinator boundary is
 * synthetic here: this is NOT native acceptance, journal, or routing coverage. */
async function providerRequest(declaration: WorkflowChoice, selected = 0) {
  const f = makeWave25Fixture('r1-choice-request')
  const directory = await mkdtemp(join(tmpdir(), 'wave25-r1-choice-')); directories.push(directory)
  const node = f.version.definition.nodes[0]!
  node.choice = declaration
  delete node.initialPrompt
  const configuration = f.configurations[0]!
  const original = structuredClone(configuration)
  const run = { ...f.run, executionLocation: { runnerId: 'local', rootPath: directory,
    locationRevision: 1, identityHash: `sha256:${'1'.repeat(64)}` } }
  const execution = HarnessExecutionSchema.parse({ ...f.executions[0]!, state: 'starting',
    workingDirectory: directory, runtimeDirectory: join(directory, node.id) })
  let captured: HarnessExecutionRequest | undefined, rendered = '', produced: unknown
  const native = {
    ensureObserve: vi.fn(async ({ request }: { request: HarnessExecutionRequest }) => {
      captured = request
      // Exactly what the native coordinator passes to the provider: no version-
      // table lookup, saved-choice access, or manually synchronized user prompt.
      rendered = buildHarnessPrompt(request)
      const text = /^Allowed routing\.outcome values: (.+)$/m.exec(rendered)?.[1]
      if (!text) throw new Error('The actual provider prompt omitted the saved output contract')
      const allowed: unknown = JSON.parse(text)
      if (!Array.isArray(allowed) || typeof allowed[selected] !== 'string') throw new Error('Invalid provider contract')
      produced = { outcome: 'succeeded', output: { routing: { outcome: allowed[selected] }, data: { observed: true } } }
      return { state: 'completed', execution: HarnessExecutionSchema.parse({ ...execution, state: 'completed',
        result: produced, finishedAt: new Date().toISOString() }), result: produced }
    }),
  }
  const store = { claimLaunch: vi.fn(async () => execution), assertNativeBoundary: vi.fn(async () => undefined) }
  const signal = new AbortController().signal
  const context = {
    run, version: f.version, signal, owner: { assertOwned: vi.fn() }, native,
    runs: { oneShot: () => store }, workflows: { getAgentConfiguration: async () => configuration },
    locations: { revalidateSnapshot: vi.fn(async () => undefined) },
    admission: { run: async (_runId: string, _signal: AbortSignal, work: () => Promise<void>) => work() },
    directory: (id: string) => join(directory, id),
  } as unknown as OneShotRuntimeContext
  await oneShotExecutionDriver(context).observe(execution, signal)
  expect(native.ensureObserve).toHaveBeenCalledTimes(1)
  expect(configuration).toEqual(original)
  expect(captured?.input).toEqual(execution.input)
  return { request: captured!, rendered, result: produced }
}

describe('BR1-007: immutable finite choices reach the actual request builder', () => {
  it.each([0, 1])('a provider using only its request can return declared outcome %s', async (selected) => {
    const declaration = choice(), observed = await providerRequest(declaration, selected)
    expect(observed.request.initialPrompt).toContain('GraphQL finite-choice output contract (version 1)')
    expect(parseChoiceResultEnvelope(observed.result, declaration).routing.outcome).toBe(declaration.outcomes[selected]!.outcome)
    expect(observed.rendered).not.toContain('private-edge')
  })
  it('changing only the saved names changes the provider-visible output contract', async () => {
    const first = await providerRequest(choice('pass', 'issues'))
    const second = await providerRequest(choice('ready', 'revise'))
    expect(first.request.initialPrompt).not.toEqual(second.request.initialPrompt)
    expect(first.request.initialPrompt).toContain('["pass","issues"]')
    expect(second.request.initialPrompt).toContain('["ready","revise"]')
  })
  it('leaves ordinary node prompts unchanged', () => {
    expect(oneShotInitialPrompt({})).toBeUndefined()
    expect(oneShotInitialPrompt({ initialPrompt: 'Do the accepted task.' })).toBe('Do the accepted task.')
  })
  it('preserves the authored task and never mutates the declaration', () => {
    const declaration = choice(), before = structuredClone(declaration)
    expect(oneShotInitialPrompt({ initialPrompt: 'Check the implementation.', choice: declaration }))
      .toMatch(/^Check the implementation\.\n\nGraphQL finite-choice/)
    expect(declaration).toEqual(before)
  })
  it('keeps the derived instruction bounded at the schema maximum', () => {
    const declaration: WorkflowChoice = { outcomes: Array.from({ length: 16 }, (_, index) => ({
      outcome: `o${index.toString().padStart(2, '0')}${'x'.repeat(45)}`, target: { kind: 'branch_end' as const },
    })) }
    expect(Buffer.byteLength(oneShotInitialPrompt({ choice: declaration })!, 'utf8')).toBeLessThan(4096)
  })
  it('does not relax strict acceptance to compensate for the request fix', () => {
    const declaration = choice()
    for (const output of [
      { routing: { outcome: 'undeclared' }, data: null },
      { routing: { outcome: 'pass', edgeId: 'private-edge' }, data: null },
      { routing: { outcome: 'pass' }, data: null, extra: true },
      { routing: { outcome: 'pass' }, data: 'x'.repeat(65536) },
      '```json\n{"routing":{"outcome":"pass"},"data":null}\n```',
    ]) expect(() => parseChoiceResultEnvelope({ outcome: 'succeeded', output }, declaration)).toThrow()
  })
})
