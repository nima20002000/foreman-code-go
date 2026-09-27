import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { it } from 'vitest'
import type { HarnessExecutionRequest, NativeHarnessEvent, ResolvedSkill } from '@graphql/contracts'
import { environment, errorCode, FixtureServer, manager, request } from './opencode-fixtures.js'

const hash = (text: string) => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`
function skilled(instructions: string, system = 'Agent rules.'): HarnessExecutionRequest {
  const base = request()
  const skill: ResolvedSkill = { skillId: 'skill-a', version: '1', name: 'Sentinel', instructions, contentHash: hash(instructions) }
  return { ...base, configuration: { ...base.configuration, prompt: { system }, instructionDelivery: 'native-v1',
    assignedSkills: [{ skillId: 'skill-a', version: '1' }], resolvedSkills: [skill] } }
}
async function drain(events: AsyncIterable<NativeHarnessEvent>) { const seen: NativeHarnessEvent[] = []; for await (const event of events) seen.push(event); return seen }
const prompts = (server: FixtureServer) => server.calls.filter((call) => call.path.includes('/prompt_async'))

it('sends the pinned bundle as system on every new turn and keeps task parts task-only', async () => {
  const server = new FixtureServer()
  const native = manager(server)
  const session = await native.createSession({ request: skilled('Reply with the word ORCHID.'), environment: environment() })
  server.onPrompt = () => { server.complete('turn-1') }
  await drain(native.startTurn(session, { prompt: 'Task one', clientCorrelationId: 'turn-1' }))
  server.onPrompt = () => { server.complete('turn-2') }
  await drain(native.startTurn(session, { prompt: 'Task two', clientCorrelationId: 'turn-2' }))
  const expected = 'Agent rules.\n\n# Skill: Sentinel (skill-a@1)\n\nReply with the word ORCHID.'
  assert.deepEqual(prompts(server).map((call) => call.body?.system), [expected, expected])
  assert.deepEqual(prompts(server).map((call) => call.body?.parts), [[{ type: 'text', text: 'Task one' }], [{ type: 'text', text: 'Task two' }]])
  // Observation and reconciliation never resubmit.
  await native.reconcile(session, 'turn-2')
  await drain(native.observeTurn(session, 'turn-2'))
  assert.equal(prompts(server).length, 2)
})

it('restores the accepted bundle on exact-session attach, not a later catalog edit, and refuses a changed bundle for a reused correlation', async () => {
  const server = new FixtureServer()
  const accepted = skilled('Accepted text.')
  const session = await manager(server).createSession({ request: accepted, environment: environment() })
  // A restarted backend attaches with the configuration persisted at acceptance.
  const restarted = manager(server)
  await restarted.attachSession(session, { request: accepted, environment: environment() })
  server.onPrompt = () => { server.complete('turn-r') }
  await drain(restarted.startTurn(session, { prompt: 'After restart', clientCorrelationId: 'turn-r' }))
  assert.equal(prompts(server).at(-1)?.body?.system, 'Agent rules.\n\n# Skill: Sentinel (skill-a@1)\n\nAccepted text.')
  // Same correlation and task text but different instructions is not the same request.
  const edited = manager(server)
  await edited.attachSession(session, { request: skilled('Edited catalog text.'), environment: environment() })
  await assert.rejects(drain(edited.startTurn(session, { prompt: 'After restart', clientCorrelationId: 'turn-r' })), errorCode('OPENCODE_CORRELATION_CONFLICT'))
  assert.equal(prompts(server).length, 1)
})

it('omits system for legacy configurations and fails before any native call on corrupt instructions', async () => {
  const server = new FixtureServer()
  const native = manager(server)
  const legacy = await native.createSession({ request: request(), environment: environment() })
  server.onPrompt = () => { server.complete('legacy') }
  await drain(native.startTurn(legacy, { prompt: 'legacy', clientCorrelationId: 'legacy' }))
  assert.equal(Object.hasOwn(prompts(server)[0]!.body!, 'system'), false)
  const corrupt = skilled('Body')
  corrupt.configuration.resolvedSkills![0]!.instructions = 'Tampered'
  const before = server.calls.length
  await assert.rejects(manager(server).createSession({ request: corrupt, environment: environment() }), errorCode('SKILL_SNAPSHOT_INVALID'))
  assert.equal(server.calls.slice(before).filter((call) => call.path === '/session' || call.path.startsWith('/session?')).length, 0)
})

it('sends pinned Operator skills as system for Operator sessions', async () => {
  const server = new FixtureServer()
  const native = manager(server)
  const body = 'Operator guidance.'
  const base = request()
  const session = await native.createSession({ kind: 'operator', correlationId: 'operator-1', workingDirectory: base.workingDirectory, environment: environment(),
    configuration: { id: 'operator-config', operatorId: 'application-operator', version: 1, harness: base.configuration.harness, contentHash: 'sha256:x',
      createdAt: '2026-09-27T00:00:00.000Z', instructionDelivery: 'native-v1', assignedSkills: [{ workspaceId: 'workspace-1', skillId: 'skill-o', version: '1' }],
      resolvedSkills: [{ skillId: 'skill-o', version: '1', name: 'Ops', instructions: body, contentHash: hash(body) }] } })
  server.onPrompt = () => { server.complete('operator-turn') }
  await drain(native.startTurn(session, { prompt: 'Help', clientCorrelationId: 'operator-turn' }))
  assert.equal(prompts(server)[0]?.body?.system, '# Skill: Ops (skill-o@1)\n\nOperator guidance.')
})
