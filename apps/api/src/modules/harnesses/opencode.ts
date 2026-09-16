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

export class OpenCodeAdapter implements HarnessAdapter {
  readonly harness = 'opencode' as const
  private readonly processes = new Map<string, ChildProcess>()

  constructor(private readonly binary: string) {}

  async qualify(request: HarnessExecutionRequest, signal?: AbortSignal): Promise<HarnessQualification> {
    if (request.configuration.harness.harness !== 'opencode') {
      throw new HarnessExecutionError('HARNESS_CONFIGURATION_MISMATCH', 'OpenCode received a non-OpenCode configuration.')
    }
    const configuration = request.configuration.harness
    const provider = configuration.model.split('/')[0]
    if (!provider) throw new HarnessExecutionError('OPENCODE_MODEL_INVALID', 'OpenCode models must include a provider prefix.')
    if (provider !== 'opencode-go') {
      throw new HarnessExecutionError('OPENCODE_PROVIDER_UNSUPPORTED', `OpenCode provider '${provider}' is not supported by the local Product adapter.`)
    }
    let checks: Awaited<ReturnType<typeof runCommand>>[]
    try {
      checks = await runCommands(this.binary, [
        ['--version'],
        ['auth', 'list'],
        ['models', provider, '--verbose'],
        ['debug', 'agent', configuration.nativeAgent],
      ], request.workingDirectory, signal)
    } catch (error) {
      throw new HarnessExecutionError('OPENCODE_UNAVAILABLE', error instanceof Error ? error.message : 'OpenCode is unavailable.')
    }
    const [version, auth, models, nativeAgent] = checks
    if (!version || !auth || !models || !nativeAgent) throw new HarnessExecutionError('OPENCODE_UNAVAILABLE', 'OpenCode qualification did not complete.')
    if (version.exitCode !== 0) throw new HarnessExecutionError('OPENCODE_UNAVAILABLE', version.stderr.trim() || 'OpenCode is unavailable.')
    const authOutput = `${auth.stdout}\n${auth.stderr}`
    if (auth.exitCode !== 0 || !authOutput.includes('OpenCode Go')) {
      throw new HarnessExecutionError('OPENCODE_AUTH_REQUIRED', authOutput.trim() || 'OpenCode Go authentication is required.')
    }
    if (models.exitCode !== 0 || !models.stdout.split('\n').includes(configuration.model)) {
      throw new HarnessExecutionError('OPENCODE_MODEL_UNAVAILABLE', `OpenCode model '${configuration.model}' is unavailable.`)
    }
    const modelStart = models.stdout.indexOf(`${configuration.model}\n`)
    const nextModel = models.stdout.indexOf('\nopencode-go/', modelStart + configuration.model.length + 1)
    const modelDetails = models.stdout.slice(modelStart, nextModel === -1 ? undefined : nextModel)
    if (!modelDetails.includes(`"${configuration.variant}"`)) {
      throw new HarnessExecutionError(
        'OPENCODE_SETTING_UNSUPPORTED',
        `OpenCode model '${configuration.model}' does not support variant '${configuration.variant}'.`,
      )
    }
    if (nativeAgent.exitCode !== 0) {
      throw new HarnessExecutionError('OPENCODE_NATIVE_AGENT_UNAVAILABLE', `OpenCode native Agent '${configuration.nativeAgent}' is unavailable.`)
    }
    return HarnessQualificationSchema.parse({
      harness: 'opencode',
      version: (version.stdout || version.stderr).trim(),
      authenticated: true,
      ready: true,
      structuredEvents: true,
      supportsResume: true,
      supportsCancellation: true,
      supportsWorkingDirectory: true,
      supportsStartupPrompt: true,
      supportedNativeTools: [
        'bash', 'read', 'edit', 'glob', 'grep', 'webfetch',
        'task', 'todowrite', 'websearch', 'lsp', 'skill',
      ],
      supportedSettings: ['model', 'variant', 'nativeAgent', 'thinking', 'autoApprove'],
      unsupportedCapabilities: ['sandboxSelection', 'serviceTier', 'interactiveApprovals'],
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
    if (configuration.harness !== 'opencode') {
      throw new HarnessExecutionError('HARNESS_CONFIGURATION_MISMATCH', 'OpenCode received a non-OpenCode configuration.')
    }
    let finalText: string | undefined
    let sessionReported = false
    let approvalRequested = false
    const prompt = buildHarnessPrompt(request)
    const args = [
      'run',
      '--format', 'json',
      '--dir', request.workingDirectory,
      '--model', configuration.model,
      '--variant', configuration.variant,
      '--agent', configuration.nativeAgent,
      ...(configuration.thinking ? ['--thinking'] : []),
      ...(configuration.autoApprove ? ['--auto'] : []),
      ...(resumeSessionId ? ['--session', resumeSessionId] : []),
    ]
    const result = await runJsonlProcess({
      binary: this.binary,
      args,
      stdin: prompt,
      cwd: request.workingDirectory,
      signal: callbacks.signal,
      ...(callbacks.beforeSpawn ? { beforeSpawn: callbacks.beforeSpawn } : {}),
      onSpawn: (process) => this.processes.set(request.executionId, process),
      onEvent: async (event) => {
        if (event.type === 'permission.asked') approvalRequested = true
        if (typeof event.payload.sessionID === 'string' && !sessionReported) {
          sessionReported = true
          await callbacks.onSession(event.payload.sessionID)
        }
        const part = event.payload.part
        if (
          event.type === 'text'
          && typeof part === 'object'
          && part !== null
          && typeof (part as Record<string, unknown>).text === 'string'
        ) {
          finalText = (part as Record<string, unknown>).text as string
        }
        await callbacks.onEvent(event)
      },
    }).finally(() => this.processes.delete(request.executionId))

    if (callbacks.signal.aborted) throw new HarnessExecutionError('EXECUTION_CANCELED', 'OpenCode execution was canceled.')
    if (approvalRequested && configuration.advanced?.permissionHandling === 'graphql_routed') {
      throw new HarnessExecutionError(
        'OPENCODE_FALLBACK_APPROVAL_UNSUPPORTED',
        'The opencode run fallback encountered a native approval request and cannot wait for GraphQL-routed review; use the qualified native server transport.',
      )
    }
    if (result.exitCode !== 0) {
      throw new HarnessExecutionError(
        'OPENCODE_EXECUTION_FAILED',
        result.stderr.trim() || `OpenCode exited with ${String(result.exitCode ?? result.exitSignal)}.`,
      )
    }
    if (!sessionReported) throw new HarnessExecutionError('OPENCODE_SESSION_ID_MISSING', 'OpenCode did not emit a native session ID.')
    if (!finalText) throw new HarnessExecutionError('OPENCODE_RESULT_MISSING', 'OpenCode completed without a final text event.')
    return { outcome: 'succeeded', output: { text: finalText } }
  }
}
