import type { HostHarnessOverride, HostHarnessProfileEvidence } from '@graphql/contracts/harness-registry'
import { ClaudeQualificationProofSchema, ClaudeQualificationPinSchema, claudeQualificationCapabilities, type ClaudeQualificationPin } from '@graphql/contracts/claude-qualification'
import { isDeepStrictEqual } from 'node:util'
import { ClaudeHarnessConfigurationSchema, type ClaudeHarnessConfiguration } from '@graphql/contracts/claude'
import { inheritedAgentEnvironment } from '../secrets.js'
import { HarnessExecutionError } from '../errors.js'

/** Only the existing HRT repository/producer supplies this exact accepted host-profile proof. */
export interface ClaudePolicyQualification {
  override: HostHarnessOverride
  persistedProof: HostHarnessProfileEvidence
  currentBinding: Pick<HostHarnessProfileEvidence, 'target' | 'instanceRevision' | 'configurationFingerprint'
    | 'driverId' | 'driverRevision' | 'protocolRevision' | 'suiteRevision' | 'environmentGeneration' | 'connectionGeneration'> & {
      instanceId: string
      pin: ClaudeQualificationPin
    }
}

export function qualifiedClaudeCapabilities(configuration: ClaudeHarnessConfiguration, qualification: ClaudePolicyQualification) {
  const { override, persistedProof: proof, currentBinding: binding } = qualification
  const vector = ClaudeQualificationProofSchema.parse(proof.claudeProof)
  const pin = ClaudeQualificationPinSchema.parse(binding.pin)
  const fields = ['target', 'instanceRevision', 'configurationFingerprint', 'driverId', 'driverRevision',
    'protocolRevision', 'suiteRevision', 'environmentGeneration', 'connectionGeneration'] as const
  if (!override.enabled || binding.instanceId !== override.instanceId
    || !isDeepStrictEqual(override.configuration, configuration)
    || !isDeepStrictEqual(override.target, proof.target) || override.instanceRevision !== proof.instanceRevision
    || override.configurationFingerprint !== proof.configurationFingerprint || override.driverId !== proof.driverId
    || fields.some((field) => !isDeepStrictEqual(proof[field], binding[field]))
    || !isDeepStrictEqual(vector.pin, pin) || pin.profilePath !== configuration.configDirectory
    || !proof.authenticated || !proof.compatible || !proof.qualified) {
    throw new HarnessExecutionError('CLAUDE_QUALIFICATION_MISMATCH', 'The persisted Claude proof differs from the current accepted host, installation, instance, profile or native runtime.')
  }
  return claudeQualificationCapabilities(vector)
}
export interface ClaudeCompiledConfiguration {
  configuration: ClaudeHarnessConfiguration
  qualification: ReturnType<typeof claudeQualificationCapabilities>
  cwd: string
  model: string
  effort?: ClaudeHarnessConfiguration['effort']
  permissionMode: 'default'
  tools: string[]
  allowedTools: string[]
  disallowedTools: string[]
  strictMcpConfig: true
  settingSources: []
  systemPrompt: string
  mcpServers: ClaudeHarnessConfiguration['mcpServers']
  env: NodeJS.ProcessEnv
  sandbox: { enabled: boolean; autoAllowBashIfSandboxed: false; allowUnsandboxedCommands: false }
}

/** Secret stripping is a delivery boundary, not host filesystem or shell isolation. */
export function claudeEnvironment(configuration: ClaudeHarnessConfiguration, source: NodeJS.ProcessEnv, apiKey?: string): NodeJS.ProcessEnv {
  const env = inheritedAgentEnvironment(source)
  for (const key of Object.keys(env)) {
    if (['BASH_ENV', 'ENV', 'NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'SSH_AUTH_SOCK'].includes(key) || /(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS)(?:_|$)/.test(key) || /^(?:ANTHROPIC_|CLAUDE_|CLAUDECODE$|OPENAI_|CODEX_|OPENCODE_|GOOGLE_|GEMINI_|AWS_|AZURE_|VERTEX_|BEDROCK_)/.test(key)) delete env[key]
  }
  env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1'
  env.CLAUDE_CONFIG_DIR = configuration.configDirectory
  if (configuration.authMode === 'api-key') {
    if (!apiKey?.trim()) throw new HarnessExecutionError('CLAUDE_API_KEY_REQUIRED', 'The accepted API-key mode requires an explicitly supplied credential.')
    env.ANTHROPIC_API_KEY = apiKey
  } else if (apiKey !== undefined) throw new HarnessExecutionError('CLAUDE_AUTH_MODE_CONFLICT', 'Subscription mode cannot receive an API key.')
  return env
}

export function requireClaudePolicyQualification(configuration: ClaudeHarnessConfiguration, qualification: ClaudePolicyQualification) {
  const capabilities = qualifiedClaudeCapabilities(configuration, qualification)
  const observedTools = qualification.persistedProof.claudeProof?.observedTools ?? []
  if (configuration.tools.some((tool) => !tool.startsWith('mcp__') && !observedTools.includes(tool))) throw new HarnessExecutionError('CLAUDE_TOOLS_UNQUALIFIED', 'The accepted built-in tools were not observed by the exact root qualification.')
  if (!capabilities.sdk || !capabilities.basicTurns || !capabilities.policy.settingsIsolation || !capabilities.policy.backgroundTasksDisabled || !capabilities.policy.alwaysAppliedToolHook
    || !(configuration.sandbox === 'read-only' ? capabilities.policy.readOnlySandbox
      : configuration.sandbox === 'workspace-write' ? capabilities.policy.workspaceWriteSandbox : capabilities.policy.fullAccessPolicy)) {
    throw new HarnessExecutionError('CLAUDE_POLICY_UNQUALIFIED', 'The selected Claude release has not proved the accepted settings, tool policy and sandbox boundaries.')
  }
  if (configuration.tools.some((tool) => ['Agent', 'Task', 'TaskOutput', 'TaskStop'].includes(tool))) {
    throw new HarnessExecutionError('CLAUDE_CHILD_TOOLS_UNQUALIFIED', 'Native child and background tools are disabled until their authority and lifecycle are qualified.')
  }
  return capabilities
}

export function compileClaudeConfiguration(raw: unknown, cwd: string, qualification: ClaudePolicyQualification,
  source: NodeJS.ProcessEnv = process.env, apiKey?: string): ClaudeCompiledConfiguration {
  const configuration = ClaudeHarnessConfigurationSchema.parse(raw)
  const capabilities = requireClaudePolicyQualification(configuration, qualification)
  return { ...claudeCandidateConfiguration(configuration, cwd, source, apiKey), qualification: capabilities }
}

/** Pure policy translation shared by owned qualification and admitted runtime.
 * This does not allocate a manager or grant production admission. */
export function claudeCandidateConfiguration(configuration: ClaudeHarnessConfiguration, cwd: string,
  source: NodeJS.ProcessEnv = process.env, apiKey?: string): Omit<ClaudeCompiledConfiguration, 'qualification'> {
  if (!cwd.startsWith('/') || cwd.includes('\0')) throw new HarnessExecutionError('CLAUDE_CWD_INVALID', 'An accepted absolute working directory is required.')
  // AskUserQuestion is a real available tool; allowedTools only configures approval, not availability.
  const tools = configuration.tools.filter(tool => !tool.startsWith('mcp__'))
  const allowedTools = configuration.permissionRules.filter((rule) => rule.effect === 'allow' && rule.tool !== 'AskUserQuestion'
    && !rule.tool.startsWith('mcp__')).map((rule) => rule.tool)
  const disallowedTools = configuration.permissionRules.filter((rule) => rule.effect === 'deny').map((rule) => rule.tool)
  return { configuration: structuredClone(configuration), cwd, model: configuration.model, permissionMode: 'default',
    ...(configuration.effort ? { effort: configuration.effort } : {}),
    tools, allowedTools, disallowedTools, strictMcpConfig: true, settingSources: [], systemPrompt: configuration.instructions,
    mcpServers: structuredClone(configuration.mcpServers), env: claudeEnvironment(configuration, source, apiKey),
    sandbox: { enabled: configuration.sandbox !== 'danger-full-access', autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false } }
}
