import { describe, expect, it } from 'vitest'

import { buildHarnessPrompt } from '../src/modules/harnesses/prompt.js'
import { runJsonlProcess } from '../src/modules/harnesses/process.js'

describe('native harness process boundary', () => {
  it('preserves structured and malformed process output as ordered events', async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = []
    const controller = new AbortController()
    const result = await runJsonlProcess({
      binary: process.execPath,
      args: ['-e', 'console.log(JSON.stringify({type:"ready",sessionID:"session-1"})); console.log("plain output")'],
      cwd: process.cwd(),
      signal: controller.signal,
      onSpawn: () => undefined,
      onEvent: async (event) => { events.push(event) },
    })
    expect(result.exitCode).toBe(0)
    expect(events).toEqual([
      { type: 'ready', payload: { type: 'ready', sessionID: 'session-1' } },
      { type: 'unparsed_stdout', payload: { text: 'plain output' } },
    ])
  })

  it('places the accepted workflow input directly into the startup prompt', () => {
    const prompt = buildHarnessPrompt({
      executionId: 'execution-1',
      runId: 'run-1',
      workspaceId: 'workspace-1',
      workflowNodeId: 'node-b',
      workingDirectory: '/tmp/graphql-run',
      configuration: {
        id: 'config-b',
        workspaceId: 'workspace-1',
        agentId: 'agent-b',
        version: 1,
        prompt: { system: 'Summarize only the supplied facts.' },
        assignedSkills: [],
        harness: {
          harness: 'opencode',
          model: 'opencode-go/deepseek-v4.1-flash',
          variant: 'max',
          nativeAgent: 'build',
          thinking: false,
          autoApprove: false,
        },
        contentHash: 'sha256:test',
        createdAt: '2026-09-14T00:00:00.000Z',
      },
      input: { previous: { result: { text: 'Exact stored result' } } },
    })
    expect(prompt).toContain('Summarize only the supplied facts.')
    expect(prompt).toContain('"text":"Exact stored result"')
    expect(prompt).toContain('Treat the accepted input above as authoritative.')
  })
})
