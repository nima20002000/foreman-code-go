import { ClaudeHarnessConfigurationSchema, type ClaudeHarnessConfiguration } from '@graphql/contracts/claude'
import { inheritedAgentEnvironment } from '../secrets.js'
import { HarnessExecutionError } from '../errors.js'

export interface ClaudePolicyQualification {
  /** Exact release checks, supplied by local qualification; never inferred from SDK types. */
  settingsIsolation: boolean
  backgroundTasksDisabled: boolean
  alwaysAppliedToolHook: boolean
  readOnlySandbox: boolean
  workspaceWriteSandbox: boolean
}
export interface ClaudeCompiledConfiguration {
  configuration: ClaudeHarnessConfiguration
  cwd: string
  model: string
  permissionMode: 'default'
  tools: string[]
  allowedTools: string[]
  disallowedTools: string[]
  strictMcpConfig: true
  settingSources: []
  systemPrompt: string
  mcpServers: ClaudeHarnessConfiguration['mcpServers']
  env: NodeJS.ProcessEnv
  sandbox: { enabled: true; autoAllowBashIfSandboxed: false; allowUnsandboxedCommands: false }
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

export function compileClaudeConfiguration(raw: unknown, cwd: string, qualification: ClaudePolicyQualification,
  source: NodeJS.ProcessEnv = process.env, apiKey?: string): ClaudeCompiledConfiguration {
  const configuration = ClaudeHarnessConfigurationSchema.parse(raw)
  if (!cwd.startsWith('/') || cwd.includes('\0')) throw new HarnessExecutionError('CLAUDE_CWD_INVALID', 'An accepted absolute working directory is required.')
  if (!qualification.settingsIsolation || !qualification.backgroundTasksDisabled || !qualification.alwaysAppliedToolHook
    || !(configuration.sandbox === 'read-only' ? qualification.readOnlySandbox : qualification.workspaceWriteSandbox)) {
    throw new HarnessExecutionError('CLAUDE_POLICY_UNQUALIFIED', 'The selected Claude release has not proved the accepted settings, tool policy and sandbox boundaries.')
  }
  if (configuration.tools.some((tool) => ['Agent', 'Task', 'TaskOutput', 'TaskStop'].includes(tool))) {
    throw new HarnessExecutionError('CLAUDE_CHILD_TOOLS_UNQUALIFIED', 'Native child and background tools are disabled until their authority and lifecycle are qualified.')
  }
  // AskUserQuestion is a real available tool; allowedTools only configures approval, not availability.
  const tools = [...configuration.tools]
  const allowedTools = configuration.permissionRules.filter((rule) => rule.effect === 'allow' && rule.tool !== 'AskUserQuestion').map((rule) => rule.tool)
  const disallowedTools = configuration.permissionRules.filter((rule) => rule.effect === 'deny').map((rule) => rule.tool)
  return { configuration: structuredClone(configuration), cwd, model: configuration.model, permissionMode: 'default',
    tools, allowedTools, disallowedTools, strictMcpConfig: true, settingSources: [], systemPrompt: configuration.instructions,
    mcpServers: structuredClone(configuration.mcpServers), env: claudeEnvironment(configuration, source, apiKey),
    sandbox: { enabled: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false } }
}
