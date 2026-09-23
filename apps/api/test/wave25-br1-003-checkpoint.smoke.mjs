/* global URL */
// Dependency-free executable registration/plan checks plus source guards. These
// do not execute PostgreSQL, LangGraph, Vitest, HTTP or any native provider.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { registerApprovalCheckpointResume } from '../src/modules/runs/approvalCheckpointRegistration.ts'
import { nextApprovalResumeValues } from '../src/infrastructure/approvalCheckpointPlan.ts'

const source = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8')

test('registration forwards the original claim and original durable interaction, not the legacy callback', async () => {
  let consumer
  const claim = { interaction: { id: 'same-durable-interaction' }, ownerToken: 'same-fence-token' }
  const seen = []
  registerApprovalCheckpointResume({ useAtomicApprovalResume(value) { consumer = value } }, {
    async resumeInteraction(interaction, actual) { seen.push([interaction, actual]) },
  })
  await consumer(claim)
  assert.equal(seen.length, 1)
  assert.equal(seen[0][0], claim.interaction)
  assert.equal(seen[0][1], claim)
})

test('registration propagates an atomic consumer failure rather than fabricating acknowledgement', async () => {
  let consumer
  const failure = new Error('checkpoint-not-committed')
  registerApprovalCheckpointResume({ useAtomicApprovalResume(value) { consumer = value } }, {
    async resumeInteraction() { throw failure },
  })
  await assert.rejects(consumer({ interaction: {}, ownerToken: 'claim' }), (error) => error === failure)
})

test('bounded sibling permutations preserve one task-local value; distinct tasks never share it', () => {
  for (let width = 1; width <= 64; width++) {
    const ids = Array.from({ length: width }, (_, index) => `interaction-${index}`)
    for (const first of [ids[0], ids.at(-1)]) {
      const plan = nextApprovalResumeValues([], ids, first)
      for (const id of [...ids].reverse()) {
        const replay = nextApprovalResumeValues(plan.values, ids, id)
        assert.equal(replay.changed, false)
        assert.equal(replay.values, plan.values)
      }
      const independent = nextApprovalResumeValues([], ['other-task'], 'other-task')
      assert.deepEqual(independent.values, [{ interactionId: 'other-task' }])
      assert.deepEqual(plan.values, [{ interactionId: first }])
    }
  }
})

test('source guard: replay validates context/digest and native work remains outside the resume helper', () => {
  const helper = source('modules/runs/approvalCheckpointResume.ts')
  const saver = source('infrastructure/approvalCheckpointSaver.ts')
  const engine = source('modules/runs/engine.ts')
  assert.match(helper, /await readContext\(sql, item, true\)/)
  assert.match(helper, /ownerToken: ''/)
  assert.match(helper, /beforeGraphCommit\(sql/)
  assert.match(helper, /order by id for share/)
  assert.match(helper, /expires_at<=clock_timestamp\(\)/)
  assert.doesNotMatch(helper, /\.(?:respond|startTurn|attachSession|createSession|invoke)\(/)
  assert.match(saver, /if \(!plan.changed\)[\s\S]*GRAPH_RESUME_RECEIPT_MISSING/)
  const terminal = engine.slice(engine.indexOf('  private async resumeTerminalRecoveries('), engine.indexOf('  private async resumeCheckpoint('))
  assert.match(terminal, /isOneShotRun\(run\) \? undefined : new Command/)
})
