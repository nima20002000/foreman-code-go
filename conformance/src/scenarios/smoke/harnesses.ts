import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { HarnessConfigurationCheckInputSchema, HarnessConfigurationCheckResultSchema } from '@foreman-code/contracts/management'
import { ClaudeSetupOptionsSchema } from '@foreman-code/contracts/claude'
import { assertResponse } from '../../assertions.js'
import type { Scenario } from '../../scenario.js'
import { assertApiError, httpCoverage } from './support.js'

const harnessesPath = '/api/management/harnesses'

export const harnessScenarios: Scenario[] = [
  {
    id: 'harness.codex-configuration-check', title: 'Installed scripted Codex qualifies the shared default configuration', lane: 'H',
    covers: [httpCoverage('POST', `${harnessesPath}/validate`, 'success')],
    async run(ctx) {
      const input = HarnessConfigurationCheckInputSchema.parse({ configuration: DEFAULT_HARNESS_DEFAULTS.codex })
      const response = await ctx.http.request('POST', `${harnessesPath}/validate`, { body: input })
      HarnessConfigurationCheckResultSchema.parse(response.body)
      assertResponse(response, {
        status: 200,
        body: {
          configuration: input.configuration, checkedAt: '<timestamp>',
          qualification: {
            harness: 'codex', version: 'codex-cli 0.154.0', authenticated: true, ready: true, structuredEvents: true,
            supportsResume: true, supportsCancellation: true, supportsWorkingDirectory: true, supportsStartupPrompt: true,
            supportedNativeTools: ['command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'plan_update'],
            supportedSettings: [
              'model', 'reasoningEffort', 'sandbox', 'serviceTier',
              'advanced.approvalPolicy', 'advanced.approvalsReviewer', 'advanced.additionalWritableDirectories',
              'advanced.workspaceWrite', 'advanced.sessionPersistence', 'advanced.shellEnvironment',
              'advanced.webSearch', 'advanced.mcpServers',
            ],
            unsupportedCapabilities: ['nativeAgentSelection'],
          },
        },
      }, [{ pointer: '/body/checkedAt', kind: 'timestamp' }])
    },
  },
  {
    id: 'harness.claude-setup-options', title: 'Claude setup exposes the actual isolated application MCP endpoint', lane: 'H',
    covers: [httpCoverage('GET', `${harnessesPath}/claude/setup-options`, 'success')],
    async run(ctx) {
      const response = await ctx.http.request('GET', `${harnessesPath}/claude/setup-options`)
      ClaudeSetupOptionsSchema.parse(response.body)
      assertResponse(response, {
        status: 200, body: { graphqlMcp: { type: 'http', url: `${ctx.target.baseUrl}/mcp` } },
      })
    },
  },
  {
    id: 'harness.claude-unconfigured', title: 'An unconfigured Claude profile reports its actual required setup', lane: 'H',
    covers: [httpCoverage('GET', `${harnessesPath}/:harness`, 'error')],
    async run(ctx) {
      const response = await ctx.http.request('GET', `${harnessesPath}/claude`)
      assertApiError(response, 409, 'HARNESS_PROFILE_REQUIRED',
        'Save a Claude preset with an actual host-local profile, model, authentication and sandbox choice in Claude settings. Installation alone does not create this app configuration.')
    },
  },
]
