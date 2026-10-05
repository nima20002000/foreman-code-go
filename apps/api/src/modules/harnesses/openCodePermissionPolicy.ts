import { APP_MCP_SERVER_NAMES } from '@foreman-code/contracts/product'

export type OpenCodePermissionEffect = 'allow' | 'ask' | 'deny'

export interface OpenCodePermissionRule {
  permission: string
  pattern: string
  effect: OpenCodePermissionEffect
}

export function openCodePermissionMatches(pattern: string, value: string): boolean {
  let expression = ''
  for (const character of pattern) {
    if (character === '*') expression += '.*'
    else if (character === '?') expression += '.'
    else expression += character.replace(/[|\\{}()[\]^$+.]/g, '\\$&')
  }
  return new RegExp(`^${expression}$`, 'u').test(value)
}

/** Native policies are ordered: the last matching rule wins. */
export function evaluateOpenCodePermission(permission: string, pattern: string,
  rules: readonly OpenCodePermissionRule[], fallback: OpenCodePermissionEffect = 'ask'): OpenCodePermissionEffect {
  let effect = fallback
  for (const rule of rules) {
    if (openCodePermissionMatches(rule.permission, permission)
      && openCodePermissionMatches(rule.pattern, pattern)) effect = rule.effect
  }
  return effect
}

export function nativeOpenCodeMcpToolName(toolName: string, serverName = 'graphql'): string {
  return `${serverName}_${toolName.replaceAll('.', '_')}`
}

export function nativeOpenCodeMcpToolNames(toolName: string): string[] {
  return APP_MCP_SERVER_NAMES.map(serverName => nativeOpenCodeMcpToolName(toolName, serverName))
}
