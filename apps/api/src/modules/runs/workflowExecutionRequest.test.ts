import { HarnessExecutionSchema } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { describe, expect, it } from 'vitest'
import { buildHarnessPrompt } from '../harnesses/prompt.js'
import { workflowExecutionRequest } from './workflowExecutionRequest.js'

function fixture() {
  const saved = makeCurrentWorkflowFixture('system-prompt-request', 'single')
  const { executionId, ...identity } = saved.identities[0]!
  const execution = HarnessExecutionSchema.parse({
    ...identity, id: executionId,
    runId: saved.run.id, state: 'starting', createdAt: saved.createdAt,
    workingDirectory: '/work', runtimeDirectory: '/runtime', input: { task: 'accepted input' },
  })
  const configuration = { ...saved.configurations[0]!, instructionDelivery: 'native-v1' as const }
  return { saved, execution, configuration }
}

describe('workflow session prompt snapshot', () => {
  it('carries the saved system prompt into the native request without repeating it in turn input', () => {
    const { saved, execution, configuration } = fixture()
    execution.systemPrompt = { value: { text: 'App instructions.' }, revision: 3, versionId: 'prompt-version-3' }
    const request = workflowExecutionRequest({ execution, version: saved.version, configuration,
      workspaceId: saved.run.workspaceId })
    expect(request.systemPrompt).toEqual(execution.systemPrompt)
    expect(buildHarnessPrompt(request)).toContain('accepted input')
    expect(buildHarnessPrompt(request)).not.toContain('App instructions.')
  })

  it('keeps historical sessions without a system prompt snapshot unchanged', () => {
    const { saved, execution, configuration } = fixture()
    const request = workflowExecutionRequest({ execution, version: saved.version, configuration,
      workspaceId: saved.run.workspaceId })
    expect(request.systemPrompt).toBeUndefined()
  })
})
