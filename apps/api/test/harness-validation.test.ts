import { describe, expect, it } from 'vitest'

import { DEFAULT_OPENCODE_ADVANCED_CONFIGURATION, type HarnessExecutionRequest } from '@graphql/contracts'

import { CodexAdapter } from '../src/modules/harnesses/codex.js'
import { OpenCodeAdapter } from '../src/modules/harnesses/opencode.js'

const baseRequest = {
  executionId: 'execution-1',
  runId: 'run-1',
  workspaceId: 'workspace-1',
  workflowNodeId: 'node-1',
  workingDirectory: process.cwd(),
  runtimeDirectory: process.cwd(),
  input: {},
} as const

describe('harness-specific validation', () => {
  it('reports a missing Codex binary without falling back', async () => {
    const request: HarnessExecutionRequest = {
      ...baseRequest,
      configuration: {
        id: 'config-codex',
        workspaceId: 'workspace-1',
        agentId: 'agent-1',
        version: 1,
        prompt: { system: 'Test' },
        assignedSkills: [],
        harness: {
          harness: 'codex',
          model: 'gpt-5.6-luna',
          reasoningEffort: 'low',
          sandbox: 'read-only',
          serviceTier: 'standard',
        },
        contentHash: 'sha256:test',
        createdAt: '2026-09-14T00:00:00.000Z',
      },
    }
    await expect(new CodexAdapter('/not/a/codex-binary').qualify(request)).rejects.toMatchObject({
      result: { error: { code: 'CODEX_UNAVAILABLE' } },
    })
  })

  it('rejects an unsupported OpenCode provider before execution', async () => {
    const request: HarnessExecutionRequest = {
      ...baseRequest,
      configuration: {
        id: 'config-opencode',
        workspaceId: 'workspace-1',
        agentId: 'agent-1',
        version: 1,
        prompt: { system: 'Test' },
        assignedSkills: [],
        harness: {
          harness: 'opencode',
          model: 'openrouter/deepseek-v4.1-flash',
          variant: 'max',
          nativeAgent: 'build',
          thinking: false,
          autoApprove: true,
          advanced: { ...DEFAULT_OPENCODE_ADVANCED_CONFIGURATION, permissionHandling: 'native_auto' },
        },
        contentHash: 'sha256:test',
        createdAt: '2026-09-14T00:00:00.000Z',
      },
    }
    await expect(new OpenCodeAdapter('opencode').qualify(request)).rejects.toMatchObject({
      result: { error: { code: 'OPENCODE_PROVIDER_UNSUPPORTED' } },
    })
  })
})
