import {
  HarnessConfigurationSchema, withAdvancedDefaults,
  type HarnessConfiguration,
} from '@graphql/contracts'

/** Raw JSON belongs to the editor, not the domain record. It must survive incomplete typing. */
export interface HarnessEditor {
  configuration: HarnessConfiguration
  shellEnvironmentText: string
  mcpText: string
}

export function createHarnessEditor(value: HarnessConfiguration): HarnessEditor {
  const configuration = withAdvancedDefaults(value)
  return {
    configuration,
    shellEnvironmentText: configuration.harness === 'codex' ? JSON.stringify(configuration.advanced!.shellEnvironment, null, 2) : '',
    mcpText: JSON.stringify(configuration.harness === 'codex'
      ? configuration.advanced!.mcpServers : configuration.advanced!.mcp.serverEnabled, null, 2),
  }
}

function json(text: string, field: string): unknown {
  try { return JSON.parse(text) } catch { throw new Error(`${field} must contain valid JSON.`) }
}

export function prepareHarnessEditor(editor: HarnessEditor): HarnessConfiguration {
  const value = withAdvancedDefaults(editor.configuration)
  return HarnessConfigurationSchema.parse(value.harness === 'codex' ? {
    ...value,
    advanced: {
      ...value.advanced,
      additionalWritableDirectories: value.advanced!.additionalWritableDirectories.filter((path) => path !== ''),
      shellEnvironment: json(editor.shellEnvironmentText, 'Shell environment'),
      mcpServers: json(editor.mcpText, 'Native MCP controls'),
    },
  } : {
    ...value,
    advanced: { ...value.advanced, mcp: { serverEnabled: json(editor.mcpText, 'Native MCP controls') } },
  })
}
