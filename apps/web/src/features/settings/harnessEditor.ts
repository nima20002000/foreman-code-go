import {
  HarnessConfigurationSchema, withAdvancedDefaults,
  type HarnessConfiguration,
} from '@graphql/contracts'

import { FieldValidationError } from './fieldValidation'

type Harness = HarnessConfiguration['harness']
interface HarnessDraft {
  configuration: HarnessConfiguration
  shellEnvironmentText: string
  mcpText: string
}

/** Raw JSON and alternate-provider drafts are editor state, never domain/API fields. */
export interface HarnessEditor extends HarnessDraft {
  drafts?: Partial<Record<Harness, HarnessDraft>>
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

export function switchHarnessEditor(editor: HarnessEditor, next: Harness, preset?: HarnessConfiguration): HarnessEditor {
  if (editor.configuration.harness === next) return editor
  const restored = editor.drafts?.[next] ?? (preset?.harness === next ? createHarnessEditor(preset) : undefined)
  if (!restored) return editor
  const { configuration, shellEnvironmentText, mcpText } = editor
  return { ...structuredClone(restored), drafts: {
    ...editor.drafts, [configuration.harness]: { configuration, shellEnvironmentText, mcpText },
  } }
}

export function resetHarnessEditor(editor: HarnessEditor, preset: HarnessConfiguration): HarnessEditor {
  if (preset.harness !== editor.configuration.harness) return editor
  const drafts = { ...editor.drafts }
  delete drafts[preset.harness]
  return { ...createHarnessEditor(preset), ...(Object.keys(drafts).length ? { drafts } : {}) }
}

function json(text: string, field: string, path: string[]): unknown {
  try { return JSON.parse(text) } catch { throw new FieldValidationError([{ path, message: `${field} must contain valid JSON.` }]) }
}

export function prepareHarnessEditor(editor: HarnessEditor): HarnessConfiguration {
  const value = withAdvancedDefaults(editor.configuration)
  return HarnessConfigurationSchema.parse(value.harness === 'codex' ? {
    ...value,
    advanced: {
      ...value.advanced,
      additionalWritableDirectories: value.advanced!.additionalWritableDirectories.filter((path) => path !== ''),
      shellEnvironment: json(editor.shellEnvironmentText, 'Shell environment', ['advanced', 'shellEnvironment']),
      mcpServers: json(editor.mcpText, 'Native MCP controls', ['advanced', 'mcpServers']),
    },
  } : {
    ...value,
    advanced: { ...value.advanced, mcp: { serverEnabled: json(editor.mcpText, 'Native MCP controls', ['advanced', 'mcp']) } },
  })
}
