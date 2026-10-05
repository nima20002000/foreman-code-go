import type { HarnessConfiguration, OpenCodeHarnessConfiguration } from '@foreman-code/contracts'
import { ALL_FILE_TOOL_NAMES, type FileToolOperation } from '../files/tools/types.js'
import { codexChatFileTools } from './codexFiles/declarations.js'

type PermissionRule = { permission: string; pattern: string; effect: string }
function patternMatches(pattern: string, value: string): boolean {
  const expression = pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')
  return new RegExp(`^${expression}$`).test(value)
}
export function openCodeArtifactMutationAllowed(configuration: OpenCodeHarnessConfiguration,
  nativeRules: readonly PermissionRule[] = []): boolean {
  if (configuration.nativeAgent === 'plan') return false
  const rules = [...nativeRules, ...(configuration.advanced?.permissionRules ?? [])]
  const mutations = ['edit', 'write', 'files.write_working_copy', 'files.publish_result',
    'files.native_output_create', 'files.native_output_append', 'files.native_output_seal', 'files.native_output_publish']
  return mutations.every(permission => {
    const matched = rules.filter(rule => patternMatches(rule.permission, permission)
      && patternMatches(rule.pattern, '*')).at(-1)
    return matched?.effect !== 'deny'
  })
}

export function workflowArtifactFilePolicy(configuration: HarnessConfiguration): {
  allowMutation: boolean
  allowedTools: FileToolOperation[]
} {
  if (configuration.harness === 'codex') return {
    allowMutation: configuration.sandbox !== 'read-only', allowedTools: codexChatFileTools(configuration),
  }
  if (configuration.harness === 'opencode') {
    const allowMutation = openCodeArtifactMutationAllowed(configuration)
    return { allowMutation, allowedTools: allowMutation ? [...ALL_FILE_TOOL_NAMES] : ['files.list', 'files.read'] }
  }
  return { allowMutation: false, allowedTools: ['files.list', 'files.read'] }
}
