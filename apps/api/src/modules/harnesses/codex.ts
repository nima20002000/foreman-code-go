import type { ChildProcess } from 'node:child_process'

import {
  HarnessQualificationSchema,
  type ExecutionResult,
  type HarnessExecutionRequest,
  type HarnessQualification,
} from '@graphql/contracts'

import { HarnessExecutionError } from './errors.js'
import type { HarnessAdapter, HarnessExecutionCallbacks } from './port.js'
import { runCommand, runCommands, runJsonlProcess, stopProcess } from './process.js'
import { buildHarnessPrompt } from './prompt.js'

interface CodexModelCatalog {
  models?: Array<{
    slug?: string
    supported_reasoning_levels?: Array<{ effort?: string }>
    additional_speed_tiers?: string[]
  }>
}

export class CodexAdapter implements HarnessAdapter {
  readonly harness = 'codex' as const
  private readonly processes = new Map<string, ChildProcess>()

  constructor(private readonly binary: string) {}

  async qualify(request: HarnessExecutionRequest, signal?: AbortSignal): Promise<HarnessQualification> {
    if (request.configuration.harness.harness !== 'codex') {
      throw new HarnessExecutionError('HARNESS_CONFIGURATION_MISMATCH', 'Codex received a non-Codex configuration.')
    }
    let checks: Awaited<ReturnType<typeof runCommand>>[]
    try {
      checks = await runCommands(this.binary, [
        ['--version'],
        ['login', 'status'],
        ['debug', 'models'],
      ], request.workingDirectory, signal)
    } catch (error) {
      throw new HarnessExecutionError('CODEX_UNAVAILABLE', error instanceof Error ? error.message : 'Codex is unavailable.')
    }
    const [version, auth, catalogResult] = checks
    if (!version || !auth || !catalogResult) throw new HarnessExecutionError('CODEX_UNAVAILABLE', 'Codex qualification did not complete.')
    if (version.exitCode !== 0) {
      throw new HarnessExecutionError('CODEX_UNAVAILABLE', version.stderr.trim() || 'Codex is unavailable.')
    }
    const authOutput = `${auth.stdout}\n${auth.stderr}`
    if (auth.exitCode !== 0 || !authOutput.includes('Logged in')) {
      throw new HarnessExecutionError('CODEX_AUTH_REQUIRED', authOutput.trim() || 'Codex authentication is required.')
    }
    if (catalogResult.exitCode !== 0) {
      throw new HarnessExecutionError('CODEX_MODEL_CATALOG_UNAVAILABLE', catalogResult.stderr.trim() || 'Codex model catalog is unavailable.')
    }
    let catalog: CodexModelCatalog
    try {
      catalog = JSON.parse(catalogResult.stdout) as CodexModelCatalog
    } catch {
      throw new HarnessExecutionError('CODEX_MODEL_CATALOG_INVALID', 'Codex returned an invalid model catalog.')
    }
    const configuration = request.configuration.harness
    const model = catalog.models?.find((candidate) => candidate.slug === configuration.model)
    if (!model) {
      throw new HarnessExecutionError('CODEX_MODEL_UNAVAILABLE', `Codex model '${configuration.model}' is unavailable.`)
    }
    if (!model.supported_reasoning_levels?.some((level) => level.effort === configuration.reasoningEffort)) {
      throw new HarnessExecutionError(
        'CODEX_SETTING_UNSUPPORTED',
        `Codex model '${configuration.model}' does not support reasoning effort '${configuration.reasoningEffort}'.`,
      )
    }
    if (configuration.serviceTier === 'priority' && !model.additional_speed_tiers?.includes('fast')) {
      throw new HarnessExecutionError('CODEX_SETTING_UNSUPPORTED', `Codex model '${configuration.model}' does not support Fast service.`)
    }
    return HarnessQualificationSchema.parse({
      harness: 'codex',
      version: (version.stdout || version.stderr).trim(),
      authenticated: true,
      ready: true,
      structuredEvents: true,
      supportsResume: true,
      supportsCancellation: true,
      supportsWorkingDirectory: true,
      supportsStartupPrompt: true,
      supportedNativeTools: ['command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'plan_update'],
      supportedSettings: ['model', 'reasoningEffort', 'sandbox', 'serviceTier'],
      unsupportedCapabilities: ['nativeAgentSelection'],
    })
  }

  async execute(request: HarnessExecutionRequest, callbacks: HarnessExecutionCallbacks): Promise<ExecutionResult> {
    const qualification = await this.qualify(request, callbacks.signal)
    await callbacks.onEvent({ type: 'harness.qualified', payload: qualification })
    return this.run(request, callbacks)
  }

  async resume(
    request: HarnessExecutionRequest,
    nativeSessionId: string,
    callbacks: HarnessExecutionCallbacks,
  ): Promise<ExecutionResult> {
    const qualification = await this.qualify(request, callbacks.signal)
    await callbacks.onEvent({ type: 'harness.qualified', payload: qualification })
    return this.run(request, callbacks, nativeSessionId)
  }

  async cancel(executionId: string): Promise<boolean> {
    const child = this.processes.get(executionId)
    return child ? stopProcess(child) : false
  }

  private async run(
    request: HarnessExecutionRequest,
    callbacks: HarnessExecutionCallbacks,
    resumeSessionId?: string,
  ): Promise<ExecutionResult> {
    const configuration = request.configuration.harness
    if (configuration.harness !== 'codex') {
      throw new HarnessExecutionError('HARNESS_CONFIGURATION_MISMATCH', 'Codex received a non-Codex configuration.')
    }
    let finalText: string | undefined
    let sessionReported = false
    const common = [
      '--json',
      '--skip-git-repo-check',
      '-m', configuration.model,
      '-c', `model_reasoning_effort="${configuration.reasoningEffort}"`,
      ...(configuration.serviceTier === 'priority' ? ['-c', 'service_tier="fast"'] : []),
    ]
    const prompt = buildHarnessPrompt(request)
    const args = resumeSessionId
      ? ['exec', 'resume', ...common, resumeSessionId, '-']
      : ['exec', ...common, '-C', request.workingDirectory, '-s', configuration.sandbox, '-']

    const result = await runJsonlProcess({
      binary: this.binary,
      args,
      stdin: prompt,
      cwd: request.workingDirectory,
      signal: callbacks.signal,
      expectedAgentId: request.configuration.agentId,
      ...(callbacks.beforeSpawn ? { beforeSpawn: callbacks.beforeSpawn } : {}),
      onSpawn: (process) => this.processes.set(request.executionId, process),
      onEvent: async (event) => {
        if (event.type === 'thread.started' && typeof event.payload.thread_id === 'string' && !sessionReported) {
          sessionReported = true
          await callbacks.onSession(event.payload.thread_id)
        }
        const item = event.payload.item
        if (
          event.type === 'item.completed'
          && typeof item === 'object'
          && item !== null
          && (item as Record<string, unknown>).type === 'agent_message'
          && typeof (item as Record<string, unknown>).text === 'string'
        ) {
          finalText = (item as Record<string, unknown>).text as string
        }
        await callbacks.onEvent(event)
      },
    }).finally(() => this.processes.delete(request.executionId))

    if (callbacks.signal.aborted) throw new HarnessExecutionError('EXECUTION_CANCELED', 'Codex execution was canceled.')
    if (result.exitCode !== 0) {
      throw new HarnessExecutionError(
        'CODEX_EXECUTION_FAILED',
        result.stderr.trim() || `Codex exited with ${String(result.exitCode ?? result.exitSignal)}.`,
      )
    }
    if (!sessionReported) throw new HarnessExecutionError('CODEX_SESSION_ID_MISSING', 'Codex did not emit a native thread ID.')
    if (!finalText) throw new HarnessExecutionError('CODEX_RESULT_MISSING', 'Codex completed without a final agent message.')
    return { outcome: 'succeeded', output: { text: finalText } }
  }
}
